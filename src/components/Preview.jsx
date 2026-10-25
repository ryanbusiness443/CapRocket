import React, { useEffect, useRef } from 'react';
import { formatTime, toFileUrl, videoLayout } from '../store.js';

// Playback uses the wall clock as master; the <video>/<audio> elements are kept in sync with it.
const DRIFT = 0.25;

function syncMedia(el, url, localTime, playing, volume) {
  if (el.dataset.src !== url) {
    el.dataset.src = url;
    el.src = url;
  }
  el.volume = Math.max(0, Math.min(1, volume));
  if (el.readyState >= 1 && Math.abs(el.currentTime - localTime) > (playing ? DRIFT : 0.01)) el.currentTime = localTime;
  if (playing && el.paused) el.play().catch(() => {});
  if (!playing && !el.paused) el.pause();
}

export default function Preview({ project, time, seekVer, playing, duration, onTime, onEnd, onTogglePlay }) {
  const videoRef = useRef(null);
  const audioEls = useRef({});
  const stageRef = useRef(null);
  const [scale, setScale] = React.useState(1);
  const mediaById = Object.fromEntries(project.media.map((m) => [m.id, m]));

  const apply = (t, isPlaying) => {
    const v = videoRef.current;
    const cur = videoLayout(project.videoClips).find((l) => t >= l.start && t < l.end);
    if (cur && mediaById[cur.clip.mediaId]) {
      const c = cur.clip;
      v.style.visibility = 'visible';
      syncMedia(v, toFileUrl(mediaById[c.mediaId].path), c.in + (t - cur.start), isPlaying, c.muted ? 0 : c.volume ?? 1);
    } else {
      v.style.visibility = 'hidden';
      if (!v.paused) v.pause();
    }
    project.audioClips.forEach((c) => {
      const el = audioEls.current[c.id];
      const m = mediaById[c.mediaId];
      if (!el || !m) return;
      const len = c.out - c.in;
      if (t >= c.start && t < c.start + len) syncMedia(el, toFileUrl(m.path), c.in + (t - c.start), isPlaying, c.volume ?? 1);
      else if (!el.paused) el.pause();
    });
  };

  // Paused: show the frame at `time`.
  useEffect(() => {
    if (!playing) apply(time, false);
  });

  // Playing: advance time with requestAnimationFrame.
  useEffect(() => {
    if (!playing) return;
    const t0 = time;
    const wall0 = performance.now();
    let raf;
    const tick = () => {
      const t = t0 + (performance.now() - wall0) / 1000;
      if (t >= duration) {
        onTime(duration);
        onEnd();
        apply(duration, false);
        return;
      }
      apply(t, true);
      onTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Restart the loop when play state toggles, the user seeks (seekVer bumps) or the project changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, seekVer, project, duration]);

  // Scale text overlays from project pixels (e.g. 1280x720) to the on-screen stage.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (stageRef.current) setScale(stageRef.current.clientWidth / project.width);
    });
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [project.width]);

  const texts = project.textClips.filter((c) => time >= c.start && time < c.start + c.duration);
  const capStyle = project.captionStyle?.style || 'karaoke';
  const caption = capStyle === 'off' ? null : (project.captionClips || []).find((c) => time >= c.start && time < c.start + c.duration);
  const fx = (project.effects || []).filter((e) => time >= e.start && time < e.start + e.duration);
  const flash = fx.find((e) => e.type === 'flash');
  const glitch = fx.some((e) => e.type === 'glitch');
  const invert = fx.some((e) => e.type === 'invert');
  const shake = fx.find((e) => e.type === 'shake');
  const shakeT = shake ? (time - shake.start) : 0;
  const stageFx = {
    filter: [glitch && 'saturate(2.2) contrast(1.3) hue-rotate(25deg)', invert && 'invert(1)', project.grade && 'contrast(1.06) saturate(1.22)'].filter(Boolean).join(' ') || undefined,
    transform: shake ? `translate(${(14 * Math.sin(shakeT * 95) * (1 - shakeT / shake.duration)) * scale}px, ${(14 * Math.sin(shakeT * 71 + 1.3) * (1 - shakeT / shake.duration)) * scale}px) scale(1.04)` : undefined,
  };

  return (
    <section className="panel preview">
      <div className="stage-wrap">
        <div className="stage" ref={stageRef} style={{ aspectRatio: `${project.width} / ${project.height}`, width: `min(100cqw, calc(100cqh * ${project.width / project.height}))` }}>
          <video ref={videoRef} preload="auto" playsInline style={stageFx} className={glitch ? 'glitching' : ''} />
          {flash && <div className="fx-flash" style={{ opacity: Math.min(0.95, 0.6 * (flash.intensity ?? 1)) * (time - flash.start < flash.duration * 0.36 ? 1 : 0.5) }} />}
          {project.audioClips.map((c) => (
            <audio key={c.id} ref={(el) => { if (el) audioEls.current[c.id] = el; else delete audioEls.current[c.id]; }} preload="auto" />
          ))}
          {caption && <CaptionView key={caption.id} caption={caption} time={time} style={capStyle} scale={scale} height={project.height}
            size={project.captionStyle?.size ?? 1} vertical={project.height > project.width} />}
          {texts.map((t) => (
            <div key={t.id} className={`overlay-text ${t.anim === 'pop' ? 'pop' : ''}`} style={{
              left: `${t.x * 100}%`, top: `${t.y * 100}%`, color: t.color,
              fontSize: `${t.size * scale}px`, textShadow: outline(Math.max(1, 2 * scale)),
            }}>{t.text}</div>
          ))}
          {!project.videoClips.length && <div className="stage-empty">Import vidéo w zidha l-timeline</div>}
        </div>
      </div>
      <div className="transport">
        <span className="tc">{formatTime(time)}</span>
        <button className="play" onClick={onTogglePlay} title="Space">{playing ? '❚❚' : '▶'}</button>
        <span className="tc dim">{formatTime(duration)}</span>
      </div>
    </section>
  );
}

// Caption preview approximating the exported ASS styles (word highlight / pop / clean).
function CaptionView({ caption, time, style, scale, height, size, vertical }) {
  const words = caption.text.split(/\s+/).filter(Boolean);
  const k = Math.min(words.length - 1, Math.floor(((time - caption.start) / caption.duration) * words.length));
  const px = (vertical ? height * 0.052 : height * 0.06) * size * scale;
  const bottom = (vertical ? 0.22 : 0.07) * 100;
  return (
    <div className={`caption-preview ${style}`} style={{ fontSize: `${px}px`, bottom: `${bottom}%`, textShadow: outline(Math.max(1.5, (px / 12))) }}>
      {words.map((w, i) => (
        <span key={i} className={style === 'karaoke' && i === k ? 'hl' : ''}>{style === 'clean' ? w : w.toUpperCase()}{' '}</span>
      ))}
    </div>
  );
}

// Black outline around preview text, matching FFmpeg drawtext's borderw.
function outline(w) {
  const s = [];
  for (let a = 0; a < 360; a += 45) {
    const r = (a * Math.PI) / 180;
    s.push(`${(Math.cos(r) * w).toFixed(2)}px ${(Math.sin(r) * w).toFixed(2)}px 0 #000`);
  }
  return s.join(',');
}
