/* ===== audio.js — 以泡泡／水聲為主軸的音效（WebAudio 合成，先不依賴外部音檔） =====
 * 首次使用者手勢後才解鎖播放，符合瀏覽器規定。
 */
(function (root) {
  'use strict';

  function create() {
    let ctx = null;
    let master = null, sfxGain = null, bgmGain = null;
    let unlocked = false;
    let bgmTimer = null, bgmStep = 0;
    const settings = { bgm: true, sfx: true, bgmVol: 0.35, sfxVol: 0.6 };

    function unlock() {
      if (unlocked) return;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      sfxGain = ctx.createGain(); sfxGain.gain.value = settings.sfx ? settings.sfxVol : 0; sfxGain.connect(master);
      bgmGain = ctx.createGain(); bgmGain.gain.value = settings.bgm ? settings.bgmVol : 0; bgmGain.connect(master);
      unlocked = true;
      if (settings.bgm) startBgm();
    }

    function tone(freq, dur, type, gainVal, slideTo, dest) {
      if (!unlocked) return;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(gainVal || 0.4, ctx.currentTime + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.connect(g); g.connect(dest || sfxGain);
      osc.start(); osc.stop(ctx.currentTime + dur + 0.02);
    }

    function noise(dur, cut, gainVal) {
      if (!unlocked) return;
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = cut || 1200;
      const g = ctx.createGain(); g.gain.value = gainVal || 0.35;
      src.connect(filt); filt.connect(g); g.connect(sfxGain);
      src.start();
    }

    /* 每個音效都往「水」的方向設計 */
    const SFX = {
      place: () => tone(520, 0.16, 'sine', 0.35, 240),          /* 咕嘟 */
      explode: () => { noise(0.42, 900, 0.5); tone(180, 0.35, 'sine', 0.3, 70); },  /* 嘩 */
      trap: () => tone(300, 0.3, 'sine', 0.35, 620),            /* 啵嗡 */
      free: () => { tone(700, 0.12, 'sine', 0.4, 1200); noise(0.1, 2600, 0.2); },   /* 啵！ */
      item: () => { tone(880, 0.1, 'triangle', 0.3); setTimeout(() => tone(1320, 0.12, 'triangle', 0.25), 70); },
      box: () => noise(0.14, 700, 0.22),
      dead: () => tone(360, 0.5, 'sine', 0.35, 90),
      rise: () => tone(90, 0.7, 'sine', 0.3, 60),
      win: () => [0, 90, 180, 300].forEach((d, i) => setTimeout(() => tone([523, 659, 784, 1047][i], 0.28, 'triangle', 0.3), d))
    };

    function play(name) {
      if (!unlocked || !settings.sfx) return;
      const fn = SFX[name];
      if (fn) fn();
    }

    /* 輕快帶水感的循環背景音樂 */
    const BGM = [523, 659, 784, 659, 587, 784, 880, 784];
    function startBgm() {
      if (!unlocked || bgmTimer) return;
      bgmTimer = setInterval(() => {
        if (!settings.bgm) return;
        const f = BGM[bgmStep % BGM.length];
        tone(f, 0.5, 'sine', 0.18, null, bgmGain);
        if (bgmStep % 4 === 0) tone(f / 2, 0.7, 'triangle', 0.12, null, bgmGain);
        bgmStep++;
      }, 420);
    }

    function set(key, value) {
      settings[key] = value;
      if (!unlocked) return;
      if (key === 'bgm' || key === 'bgmVol') bgmGain.gain.value = settings.bgm ? settings.bgmVol : 0;
      if (key === 'sfx' || key === 'sfxVol') sfxGain.gain.value = settings.sfx ? settings.sfxVol : 0;
      if (key === 'bgm' && value) startBgm();
    }

    return { unlock, play, set, settings, get unlocked() { return unlocked; } };
  }

  root.Audio2 = { create };
})(typeof self !== 'undefined' ? self : this);
