/**
 * Browser side of Scrypted's RTCSignalingSession, implemented against the SDK
 * interface rather than imported from @scrypted/common - that package is not
 * published for browser use, and the interface is small enough to own.
 *
 * Contract (sdk/types RTCSignalingSession):
 *   options                                          - readable over RPC
 *   createLocalDescription(type, setup, sendIceCandidate)
 *   setRemoteDescription(description, setup)
 *   addIceCandidate(candidate)
 *   getOptions()                                     - deprecated but kept
 *
 * The plugin drives the exchange and may take either role, so both the
 * offer and the answer path have to work.
 */
export class BrowserSession {
  constructor({ onTrack, onStateChange, onNegotiationNeeded } = {}) {
    this.pc = null;
    this.micSender = null;
    this.micStream = null;
    this.micEnabled = false;
    this.onTrack = onTrack || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onNegotiationNeeded = onNegotiationNeeded || (() => {});
    this.canTalk = false;
    this.canListen = false;

    this.options = {
      userAgent: navigator.userAgent,
      capabilities: {
        audio: RTCRtpReceiver.getCapabilities
          ? RTCRtpReceiver.getCapabilities('audio') : undefined,
        video: RTCRtpReceiver.getCapabilities
          ? RTCRtpReceiver.getCapabilities('video') : undefined,
      },
      screen: {
        devicePixelRatio: window.devicePixelRatio,
        width: window.screen.width,
        height: window.screen.height,
      },
    };
    // The session is passed to the plugin as an RPC proxy; this is how the
    // remote side reads `options` without a round trip.
    this.__proxy_props = { options: this.options };
  }

  async getOptions() {
    return this.options;
  }

  async createLocalDescription(type, setup, sendIceCandidate) {
    const pc = await this._peerConnection(setup);

    if (sendIceCandidate) {
      pc.onicecandidate = (event) => {
        if (event.candidate) sendIceCandidate(event.candidate.toJSON());
      };
    }

    const description = type === 'offer'
      ? await pc.createOffer()
      : await pc.createAnswer();
    await pc.setLocalDescription(description);

    // With trickle the plugin gets candidates as they arrive, so the local
    // description can go out immediately. Without it, the SDP is only complete
    // once gathering finished.
    if (!sendIceCandidate) await this._awaitIceGathering(pc);

    // Return a plain object: an RTCSessionDescription does not survive RPC.
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  }

  async setRemoteDescription(description, setup) {
    const pc = await this._peerConnection(setup);
    await pc.setRemoteDescription(description);
  }

  async addIceCandidate(candidate) {
    await this.pc.addIceCandidate(candidate);
  }

  /**
   * Two-way audio. The transceiver is negotiated up front but starts without a
   * track, so no microphone prompt appears until the user actually presses talk.
   * replaceTrack() needs no renegotiation.
   */
  async setMicrophone(enabled) {
    if (!this.micSender) return false;

    if (!enabled) {
      // Release the microphone instead of muting it. Upstream sets
      // track.enabled = false to avoid a second permission prompt, but the grant
      // is persisted per origin so re-enabling does not prompt again - and a live
      // muted track keeps the tab holding the device with the browser's recording
      // indicator lit, which reads as "still listening". Detaching also stops the
      // RTP, but that alone does not free the camera's talkback channel: the
      // caller still has to stop the intercom via setPlayback({audio:false}).
      await this.micSender.replaceTrack(null).catch(() => {});
      this._stopMicStream();
      return false;
    }

    if (!this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    await this.micSender.replaceTrack(this.micStream.getAudioTracks()[0]);
    this.micEnabled = true;
    return true;
  }

  /**
   * Decoded video frames, for the stream watchdog. A peer connection happily
   * stays in "connected" after the camera stopped sending, which is exactly the
   * failure that left a frozen picture on screen with no error anywhere.
   * Returns null when there is nothing to measure yet.
   */
  async framesDecoded() {
    if (!this.pc) return null;
    const stats = await this.pc.getStats();
    let frames = null;
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'video'
          && typeof report.framesDecoded === 'number') {
        frames = (frames || 0) + report.framesDecoded;
      }
    });
    return frames;
  }

  close() {
    this._stopMicStream();
    if (this.pc) {
      for (const sender of this.pc.getSenders()) {
        if (sender.track) sender.track.stop();
      }
      this.pc.close();
      this.pc = null;
    }
  }

  async _peerConnection(setup) {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection(setup.configuration || {});
    this.pc = pc;

    pc.ontrack = (event) => this.onTrack(event);
    pc.onconnectionstatechange = () => this.onStateChange(pc.connectionState);
    // RTCSessionControl exposes no way to renegotiate, so if this fires there is
    // nobody to tell. It should never fire - replaceTrack() needs no
    // renegotiation - so the card only reports it.
    pc.onnegotiationneeded = () => this.onNegotiationNeeded();

    if (setup.datachannel) {
      pc.createDataChannel(setup.datachannel.label, setup.datachannel.dict);
    }

    const direction = setup.audio && setup.audio.direction;
    // Whether the camera's audio will reach us, decided at negotiation time on
    // purpose. Audio and video arrive as separate ontrack events and
    // connectionState can reach 'connected' before the audio one has fired, so
    // counting tracks on the stream would report "no audio" for a camera that has
    // it, and nothing would re-evaluate that. Weaker but race-free: negotiated
    // audio is not proof of an audible camera, only of a channel for it.
    //
    // A missing direction counts as receive-capable on purpose. The plugin's
    // converter path sends `intercom ? 'sendrecv' : undefined` where the mixin path
    // sends `'recvonly'`, and the transceiver added below defaults to sendrecv
    // anyway - so the audio does arrive and only the flag was wrong. canTalk must
    // NOT follow suit: without an Intercom reference the plugin's
    // setPlaybackInternal returns immediately, so a talk button would promise
    // something that cannot work.
    this.canListen = direction === 'sendrecv' || direction === 'recvonly'
      || (!!setup.audio && !direction);

    if (direction === 'sendrecv' || direction === 'sendonly') {
      // The camera exposes Intercom, so the plugin wants our audio. Keep the
      // sender for setMicrophone().
      //
      // The transceiver stays empty on purpose. A track here - even a silent
      // placeholder - makes RTP flow from the moment the stream starts, and the
      // plugin's ScryptedSessionControl.setPlaybackInternal (webrtc plugin,
      // session-control.ts) is waiting on exactly that:
      //
      //   if (!audioTransceiver.receiver.track) await onTrack.asPromise()
      //   await intercom.stopIntercom()
      //   if (!options.audio) return
      //   ... startIntercom(mo)
      //
      // So a track at negotiation time starts the camera's intercom at stream
      // start and occupies its exclusive talkback channel for the whole session.
      // The intent is signalled through setPlayback({audio}) instead, which the
      // card calls when the talk button is pressed - see _onMic in card.js. The
      // parked promise is also why the original failure was silent: the call
      // neither resolved nor rejected, so nothing was ever logged.
      this.micSender = pc.addTransceiver('audio', setup.audio).sender;
      this.canTalk = true;
    } else if (setup.audio) {
      pc.addTransceiver('audio', setup.audio);
    }

    if (setup.video) pc.addTransceiver('video', setup.video);

    return pc;
  }

  _awaitIceGathering(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (pc.iceGatheringState !== 'complete') return;
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  _stopMicStream() {
    this.micEnabled = false;
    if (!this.micStream) return;
    for (const track of this.micStream.getTracks()) track.stop();
    this.micStream = null;
  }
}
