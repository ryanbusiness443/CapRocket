// Unit tests for the project store (undo/redo, transitions, new tracks). Run: npm run test:store
import { historyReducer, emptyProject, videoLayout, projectDuration } from '../src/store.js';
const p = { ...emptyProject(), media: [{ id: 'm', duration: 20, type: 'video' }],
  videoClips: [{ id: 'a', mediaId: 'm', in: 0, out: 5, transition: { type: 'zoomin', duration: 0.4 } }, { id: 'b', mediaId: 'm', in: 6, out: 10 }],
  effects: [{ id: 'e', type: 'glitch', start: 1, duration: 0.3 }], captionClips: [{ id: 'k', text: 'hi', start: 2, duration: 1 }] };
let s = { past: [], present: p, future: [] };
const D = (a) => (s = historyReducer(s, a));
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('  ✓', m); };
ok(Math.abs(videoLayout(s.present.videoClips)[1].start - 4.6) < 1e-9, 'transition overlap in layout');
D({ type: 'delete', track: 'transition', id: 'a' }); ok(!s.present.videoClips[0].transition, 'delete removes a transition');
D({ type: 'undo' }); ok(s.present.videoClips[0].transition, 'undo restores it');
D({ type: 'update', track: 'transition', id: 'a', patch: {} }); ok(true, 'update with unknown track is ignored');
D({ type: 'split', track: 'caption', id: 'k', t: 2.5, newId: 'k2' }); ok(s.present.captionClips.length === 2, 'split a caption');
D({ type: 'split', track: 'effect', id: 'e', t: 1.1, newId: 'e2' }); ok(s.present.effects.length === 2, 'split an effect');
D({ type: 'transitionAll', transition: { type: 'fade', duration: 0.3 } }); ok(s.present.videoClips[0].transition.type === 'fade' && !s.present.videoClips[1].transition, 'apply to all cuts');
D({ type: 'replace', project: { name: 'old', width: 1280, height: 720, fps: 30, media: [], videoClips: [], textClips: [], audioClips: [] } });
ok(Array.isArray(s.present.effects) && Array.isArray(s.present.captionClips), 'old projects get the new tracks');
D({ type: 'undo' }); ok(s.present.videoClips.length === 2, 'Auto Edit replace is undoable');
ok(projectDuration(s.present) > 8, 'duration');
console.log('STORE OK');
