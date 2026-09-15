import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createSpring, SPRINGS, projectedSnap, releaseVelocity, rubberBand } from '../lib/spring.js';

export function useReducedMotion() {
  const [reduce, setReduce] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { const query = window.matchMedia('(prefers-reduced-motion: reduce)'); const change = () => setReduce(query.matches); query.addEventListener('change', change); change(); return () => query.removeEventListener('change', change); }, []);
  return reduce;
}

// Immediate visual acknowledgment; native click, focus and keyboard semantics are untouched.
export function PressFeedback() {
  const reduce = useReducedMotion();
  useEffect(() => {
    const springs = new Map(), pointers = new Map(); let keyboard;
    const selector = 'button, a.btn, a.ci, summary';
    const eligible = target => {
      const element = target instanceof Element ? target.closest(selector) : null;
      return element && !element.matches(':disabled,[aria-disabled="true"],[data-no-press],.sidebar-scrim') && !element.closest('[inert]') ? element : null;
    };
    function release(element) {
      if (!element) return;
      delete element.dataset.pressing;
      const entry = springs.get(element);
      entry?.spring.to(1, { ...SPRINGS.press, immediate: reduce, onRest: () => { element.style.scale = entry.original; springs.delete(element); } });
    }
    function press(element) {
      if (!element) return;
      element.dataset.pressing = 'true';
      if (reduce) return;
      let entry = springs.get(element);
      if (!entry) {
        entry = { original: element.style.scale, spring: createSpring(1, value => { element.style.scale = String(value); }) };
        springs.set(element, entry);
      }
      entry.spring.to(1 - Math.min(.025, 2 / Math.max(1, element.getBoundingClientRect().width)), SPRINGS.press);
    }
    const down = event => { if (!event.isPrimary || event.button !== 0) return; const element = eligible(event.target); if (element) { pointers.set(event.pointerId, { element, x: event.clientX, y: event.clientY }); press(element); } };
    const move = event => { const pointer = pointers.get(event.pointerId); if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) { release(pointer.element); pointers.delete(event.pointerId); } };
    const up = event => { release(pointers.get(event.pointerId)?.element); pointers.delete(event.pointerId); };
    const keydown = event => { if (!event.repeat && ['Enter', ' '].includes(event.key)) { keyboard = eligible(event.target); press(keyboard); } };
    const keyup = event => { if (['Enter', ' '].includes(event.key)) { release(keyboard); keyboard = null; } };
    const reset = () => { pointers.forEach(pointer => release(pointer.element)); pointers.clear(); release(keyboard); keyboard = null; };
    const listeners = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up, keydown, keyup };
    Object.entries(listeners).forEach(([name, handler]) => document.addEventListener(name, handler, true));
    window.addEventListener('blur', reset); document.addEventListener('visibilitychange', reset);
    return () => {
      Object.entries(listeners).forEach(([name, handler]) => document.removeEventListener(name, handler, true));
      window.removeEventListener('blur', reset); document.removeEventListener('visibilitychange', reset);
      springs.forEach((entry, element) => { entry.spring.stop(); element.style.scale = entry.original; delete element.dataset.pressing; });
      pointers.forEach(pointer => { delete pointer.element.dataset.pressing; }); if (keyboard) delete keyboard.dataset.pressing;
    };
  }, [reduce]);
  return null;
}

// Retain an exiting surface. Reopening redirects the same spring, never a new entrance.
export function useSurfaceMotion(open, { native = false, anchor, origin = 'top right' } = {}) {
  const ref = useRef(null), controller = useRef(null), latest = useRef(open), reduced = useRef(false);
  const [retained, setRetained] = useState(open), reduce = useReducedMotion(); latest.current = open; reduced.current = reduce;
  const present = open || retained;
  useLayoutEffect(() => {
    const node = ref.current; if (!node) { controller.current?.stop(); controller.current = null; return; }
    if (native && open && !node.open) node.showModal();
    if (open) setRetained(true);
    node.style.transformOrigin = origin;
    if (anchor?.current) {
      const trigger = anchor.current.getBoundingClientRect(), bounds = node.getBoundingClientRect();
      node.style.transformOrigin = `${Math.max(0, Math.min(bounds.width, trigger.left + trigger.width / 2 - bounds.left))}px 0px`;
    }
    if (!controller.current) controller.current = createSpring(0, progress => {
      node.style.opacity = String(Math.max(0, Math.min(1, progress)));
      node.style.transform = reduced.current ? 'none' : `translate3d(0,${(1 - progress) * -8}px,0) scale(${.975 + progress * .025})`;
      node.style.setProperty('--surface-progress', String(Math.max(0, Math.min(1, progress))));
    });
    // Refresh the renderer on preference changes without losing presentation state.
    const current = controller.current;
    node.dataset.fluidSurface = 'true'; node.style.willChange = reduce ? 'auto' : 'transform, opacity';
    if (!current.running && current.value === 0 && open) current.jump(0);
    current.to(open ? 1 : 0, { ...SPRINGS.menu, immediate: reduce, onRest: () => {
      node.style.willChange = 'auto';
      if (!latest.current) { if (native && node.open) node.close(); setRetained(false); }
    } });
    if (reduce) node.style.transform = 'none';
  }, [open, present, reduce, native, anchor, origin]);
  useEffect(() => () => { controller.current?.stop(); }, []);
  return { ref, present };
}

export function useLeadPanelMotion(panel, scrim, onClosed) {
  const spring = useRef(null), gesture = useRef(null), close = useRef(onClosed), reduced = useRef(false), suppressClick = useRef(false);
  const reduce = useReducedMotion(); close.current = onClosed; reduced.current = reduce;
  const distance = useRef(600), intent = useRef(false);
  const settle = useCallback((dismiss, velocity, momentum = false) => {
    intent.current = dismiss;
    const node = panel.current; if (!node || !spring.current) return;
    node.dataset.motionState = dismiss ? 'closing' : 'opening'; node.style.willChange = reduced.current ? 'auto' : 'transform';
    spring.current.to(dismiss ? distance.current : 0, {
      ...SPRINGS.sheet, damping: momentum ? .8 : 1, velocity, immediate: reduced.current, restDelta: .1, restSpeed: 2,
      onRest: () => { node.style.willChange = 'auto'; node.dataset.motionState = dismiss ? 'closed' : 'open'; if (dismiss) close.current(); },
    });
  }, [panel]);
  useLayoutEffect(() => {
    const node = panel.current; if (!node) return;
    distance.current = node.offsetWidth + 24;
    spring.current = createSpring(distance.current, value => {
      node.style.transform = `translate3d(${value}px,0,0)`;
      if (scrim.current) scrim.current.style.opacity = String(1 - Math.max(0, Math.min(1, value / distance.current)));
    });
    spring.current.jump(reduced.current ? 0 : distance.current); settle(false);
    const resize = () => { distance.current = node.offsetWidth + 24; if (gesture.current) cancel(); else settle(intent.current); };
    const observer = new ResizeObserver(resize); observer.observe(node);
    const cancel = () => { if (gesture.current) { gesture.current = null; suppressClick.current = true; settle(false); } };
    window.addEventListener('blur', cancel); document.addEventListener('visibilitychange', cancel);
    return () => { observer.disconnect(); spring.current.stop(); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', cancel); };
  }, [panel, scrim, settle]);
  useEffect(() => { if (reduce && spring.current?.running && !gesture.current) settle(intent.current); }, [reduce, settle]);
  const handlers = {
    onPointerDown(event) {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick.current = false;
      const motion = spring.current; motion.stop();
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: motion.value, claimed: false, samples: [{ value: motion.value, time: event.timeStamp }] };
      panel.current.dataset.motionState = 'grabbed'; event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event) {
      const drag = gesture.current; if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.claimed) {
        if (Math.hypot(dx, dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx)) { gesture.current = null; suppressClick.current = true; settle(false); event.currentTarget.releasePointerCapture(event.pointerId); return; }
        drag.claimed = true; suppressClick.current = true;
      }
      event.preventDefault();
      const next = rubberBand(drag.start + dx, 0, distance.current);
      drag.samples.push({ value: next, time: event.timeStamp }); drag.samples = drag.samples.slice(-20);
      spring.current.jump(next, releaseVelocity(drag.samples, event.timeStamp)); panel.current.dataset.motionState = 'dragging';
    },
    onPointerUp(event) {
      const drag = gesture.current; if (!drag || drag.id !== event.pointerId) return;
      gesture.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
      if (!drag.claimed) { settle(false); return; }
      const velocity = releaseVelocity(drag.samples, event.timeStamp);
      const target = projectedSnap(spring.current.value, velocity, [0, distance.current]);
      settle(target !== 0, velocity, Math.abs(velocity) > 450);
    },
    onPointerCancel() { if (gesture.current) { gesture.current = null; suppressClick.current = true; settle(false); } },
    onLostPointerCapture() { if (gesture.current) { gesture.current = null; suppressClick.current = true; settle(false); } },
    onClick(event) { if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; } else settle(true); },
  };
  return { dismiss: useCallback(() => settle(true), [settle]), handlers };
}

export function useNavigationMotion(rail, open) {
  const scrim = useRef(null), controller = useRef(null), currentOpen = useRef(open), reduced = useRef(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const [retained, setRetained] = useState(false), reduce = useReducedMotion();
  currentOpen.current = open; reduced.current = reduce;
  useEffect(() => { const query = window.matchMedia('(max-width: 900px)'); const update = () => setMobile(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  useLayoutEffect(() => {
    const node = rail.current; if (!node) return;
    if (!mobile) {
      controller.current?.stop(); controller.current = null; setRetained(false);
      node.style.removeProperty('transform'); node.style.removeProperty('visibility'); node.style.removeProperty('will-change'); node.inert = false; return;
    }
    if (open) setRetained(true);
    if (!controller.current) { controller.current = createSpring(0, progress => {
      node.style.transform = `translate3d(${(progress - 1) * node.offsetWidth}px,0,0)`;
      if (scrim.current) scrim.current.style.opacity = String(Math.max(0, Math.min(1, progress)));
    }); controller.current.jump(0); }
    node.inert = !open; node.style.visibility = open || retained ? 'visible' : 'hidden';
    node.style.willChange = reduce ? 'auto' : 'transform';
    controller.current.to(open ? 1 : 0, { ...SPRINGS.sheet, immediate: reduce, onRest: () => {
      node.style.willChange = 'auto'; if (!currentOpen.current) { node.style.visibility = 'hidden'; setRetained(false); }
    } });
  }, [open, retained, mobile, reduce, rail]);
  useEffect(() => () => controller.current?.stop(), []);
  return { scrim, present: mobile && (open || retained) };
}
