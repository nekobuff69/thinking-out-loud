/**
 * Renders a live waveform visualization on a canvas element.
 * Driven by an AnalyserNode's time-domain data.
 * Shows amplitude bars when audio is playing, idle breathing when silent.
 */
export function createWaveform(canvas, analyser, color) {
  const ctx = canvas.getContext("2d");
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  let animationId = null;
  let isActive = false;
  let idlePhase = 0;
  const idleSpeed = 0.03;
  const amplitudeThreshold = 10; // above this = active

  // Sync canvas drawing buffer to its actual rendered size
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  function draw() {
    animationId = requestAnimationFrame(draw);

    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Read analyser data
    analyser.getByteTimeDomainData(dataArray);

    // Compute RMS amplitude to detect active vs idle
    let rms = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (dataArray[i] - 128) / 128;
      rms += v * v;
    }
    rms = Math.sqrt(rms / bufferLength);

    const wasActive = isActive;
    isActive = rms > amplitudeThreshold / 128;

    ctx.clearRect(0, 0, w, h);

    if (isActive) {
      // Active: draw amplitude bars from time-domain data
      const barCount = 32;
      const barWidth = w / barCount;
      const step = Math.floor(bufferLength / barCount);

      for (let i = 0; i < barCount; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
          const v = (dataArray[i * step + j] - 128) / 128;
          sum += Math.abs(v);
        }
        const avg = sum / step;
        const barHeight = avg * h * 1.5;

        const x = i * barWidth + 1;
        const y = (h - barHeight) / 2;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.6 + avg * 0.4;
        ctx.fillRect(x, y, barWidth - 2, Math.max(barHeight, 2));
      }
      ctx.globalAlpha = 1;
    } else {
      // Idle: gentle breathing animation
      idlePhase += idleSpeed;
      const breath = 0.3 + 0.15 * Math.sin(idlePhase);
      const barCount = 32;
      const barWidth = w / barCount;

      for (let i = 0; i < barCount; i++) {
        // Sine wave breathing pattern with slight phase offset per bar
        const phase = idlePhase + (i / barCount) * Math.PI * 2;
        const hNorm = breath * (0.5 + 0.5 * Math.sin(phase));
        const barHeight = hNorm * h;

        const x = i * barWidth + 1;
        const y = (h - barHeight) / 2;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.25 + hNorm * 0.3;
        ctx.fillRect(x, y, barWidth - 2, Math.max(barHeight, 2));
      }
      ctx.globalAlpha = 1;
    }
  }

  draw();

  return {
    stop() {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
      resizeObserver.disconnect();
    },
  };
}
