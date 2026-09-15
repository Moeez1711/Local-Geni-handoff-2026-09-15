// Response is the undamped period in seconds, not a promised completion time.
// Unit mass: stiffness = (2π / response)², damping = 2ζ√stiffness.
export const SPRINGS = {
  press: { response: .16, damping: 1 },
  menu: { response: .22, damping: 1 },
  move: { response: .4, damping: 1 },
  sheet: { response: .3, damping: 1 },
};

export function stepSpring(value, velocity, target, seconds, { response = .3, damping = 1 } = {}) {
  const w = 2 * Math.PI / response, z = Math.min(1, Math.max(.01, damping));
  const x = value - target, t = Math.max(0, seconds);
  if (z >= .999) {
    const b = velocity + w * x, decay = Math.exp(-w * t);
    return { value: target + (x + b * t) * decay, velocity: (velocity - w * b * t) * decay };
  }
  const wd = w * Math.sqrt(1 - z * z), a = z * w;
  const b = (velocity + a * x) / wd, decay = Math.exp(-a * t), sin = Math.sin(wd * t), cos = Math.cos(wd * t);
  return { value: target + decay * (x * cos + b * sin), velocity: decay * ((b * wd - a * x) * cos - (x * wd + a * b) * sin) };
}

export function createSpring(initial, update, clock = {}) {
  const request = clock.request || (fn => requestAnimationFrame(fn));
  const cancel = clock.cancel || (id => cancelAnimationFrame(id));
  const now = clock.now || (() => performance.now());
  let value = initial, velocity = 0, target = initial, frame = null, previous = 0, finish;
  let options = SPRINGS.sheet;
  function stop() { if (frame !== null) cancel(frame); frame = null; finish = undefined; }
  function tick(time) {
    frame = null;
    // A suspended tab resumes from its last visible frame, without teleporting.
    const dt = Math.min(.032, Math.max(0, (time - previous) / 1000)); previous = time;
    ({ value, velocity } = stepSpring(value, velocity, target, dt, options));
    if (Math.abs(value - target) < (options.restDelta ?? .001) && Math.abs(velocity) < (options.restSpeed ?? .01)) {
      value = target; velocity = 0; update(value, velocity);
      const done = finish; finish = undefined; done?.();
    } else { update(value, velocity); frame = request(tick); }
  }
  return {
    get value() { return value; }, get velocity() { return velocity; }, get target() { return target; },
    get running() { return frame !== null; },
    stop,
    jump(next, speed = 0) { stop(); value = target = next; velocity = speed; update(value, velocity); },
    to(next, config = {}) {
      stop(); target = next; options = { ...SPRINGS.sheet, ...config }; finish = config.onRest;
      if (Number.isFinite(config.velocity)) velocity = config.velocity;
      if (config.immediate) { value = target; velocity = 0; update(value, velocity); const done = finish; finish = undefined; done?.(); return; }
      previous = now(); frame = request(tick);
    },
  };
}

export function rubberBand(value, min, max, range = 64) {
  if (value >= min && value <= max) return value;
  const edge = value < min ? min : max, distance = value - edge;
  return edge + Math.sign(distance) * range * (1 - 1 / (Math.abs(distance) / range + 1));
}

// v(t) = v₀ exp(-t/τ); its integral is v₀τ. Choose from the projected rest point.
export function projectedSnap(position, velocity, targets, tau = .18) {
  const projected = position + velocity * tau;
  return targets.reduce((nearest, next) => Math.abs(next - projected) < Math.abs(nearest - projected) ? next : nearest);
}

export function releaseVelocity(samples, releaseTime) {
  if (samples.length < 2 || releaseTime - samples.at(-1).time > 80) return 0;
  const last = samples.at(-1), first = samples.find(sample => last.time - sample.time <= 80) || samples[0];
  const dt = last.time - first.time;
  return dt > 0 ? Math.max(-2400, Math.min(2400, (last.value - first.value) * 1000 / dt)) : 0;
}
