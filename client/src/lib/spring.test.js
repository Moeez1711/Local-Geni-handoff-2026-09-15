import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpring, stepSpring, SPRINGS, rubberBand, projectedSnap, releaseVelocity } from './spring.js';

function testClock() {
  let time = 0, id = 0; const frames = new Map();
  return { now: () => time, request: fn => { frames.set(++id, fn); return id; }, cancel: key => frames.delete(key),
    tick(ms = 16) { time += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); },
    finish() { for (let i = 0; frames.size && i < 200; i++) this.tick(); assert.equal(frames.size, 0); } };
}
test('critical spring closes monotonically and is stable across frame rates', () => {
  for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
    let state = { value: 600, velocity: 0 };
    for (let i = 0; i < 2 / dt; i++) { const next = stepSpring(state.value, state.velocity, 0, dt, SPRINGS.sheet); assert.ok(next.value >= -1e-8 && next.value <= state.value); state = next; }
    assert.ok(Math.abs(state.value) < .001);
  }
});
test('interruption preserves live position and velocity, and cancels the old completion', () => {
  const clock = testClock(); let stale = false, done = false;
  const spring = createSpring(600, () => {}, clock);
  spring.to(0, { onRest: () => { stale = true; } }); clock.tick(); clock.tick(); clock.tick();
  const position = spring.value, velocity = spring.velocity;
  spring.to(600, { onRest: () => { done = true; } });
  assert.equal(spring.value, position); assert.equal(spring.velocity, velocity);
  clock.finish(); assert.equal(stale, false); assert.equal(done, true); assert.equal(spring.value, 600);
});
test('gesture handoff carries velocity; grab stops without a presentation jump', () => {
  const clock = testClock(), spring = createSpring(0, () => {}, clock);
  spring.jump(160, 900); spring.to(600, { velocity: 900, damping: .8 }); clock.tick();
  assert.ok(spring.value > 160); const position = spring.value;
  spring.stop(); clock.tick(); assert.equal(spring.value, position); assert.ok(spring.velocity > 0);
});
test('exponential projection can dismiss before midpoint or reverse a far drag', () => {
  assert.equal(projectedSnap(150, 1100, [0, 600]), 600);
  assert.equal(projectedSnap(400, -1100, [0, 600]), 0);
  assert.equal(projectedSnap(290, 0, [0, 600]), 0);
});
test('rubber band is continuous, tracks inside the bounds, and approaches a finite edge', () => {
  assert.equal(rubberBand(120, 0, 600), 120); assert.equal(rubberBand(0, 0, 600), 0);
  assert.ok(rubberBand(-1, 0, 600) < 0); assert.ok(rubberBand(-10000, 0, 600) > -64);
  assert.ok(rubberBand(10000, 0, 600) < 664);
});
test('release velocity discards stale flicks and caps accidental spikes', () => {
  assert.equal(releaseVelocity([{ value: 0, time: 0 }, { value: 100, time: 50 }], 55), 2000);
  assert.equal(releaseVelocity([{ value: 0, time: 0 }, { value: 100, time: 50 }], 150), 0);
  assert.equal(releaseVelocity([{ value: 0, time: 0 }, { value: 1000, time: 1 }], 1), 2400);
});
test('reduced motion snaps immediately; a long stalled frame cannot teleport a panel', () => {
  const clock = testClock(), spring = createSpring(600, () => {}, clock); let complete = 0;
  spring.to(0, { immediate: true, onRest: () => complete++ }); assert.equal(spring.value, 0); assert.equal(complete, 1); assert.equal(spring.running, false);
  spring.to(600); clock.tick(4000); assert.ok(spring.value < 150); clock.finish(); assert.equal(spring.value, 600);
});
