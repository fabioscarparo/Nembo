"use client";

/**
 * Timers that stop when nobody is looking.
 *
 * Everything this app keeps up to date is on a clock — the newest observation
 * every minute, the place every quarter of an hour, the steering wind every
 * half, the loop on its own frame timer — and none of it used to stop. A phone
 * left in a pocket with Nembo open kept asking the service what the latest
 * frame was, pulling twenty-seven tiles whenever the answer changed, and
 * spending a hundred and twenty milliseconds estimating motion for a picture
 * nobody was going to see. Measured over matched windows: eleven requests in
 * seventy-five seconds with the tab in front, zero with it behind.
 *
 * The module is two pieces. `usePageVisible` is the raw signal; every timer in
 * the app is gated on it. `useVisibleInterval` is the thing to actually reach
 * for — a `setInterval` that knows about visibility, about first runs, and
 * about the moment its subject changes underneath it.
 */

import { useEffect, useRef, useState } from "react";

/**
 * Whether the page is actually being looked at.
 *
 * Starts `true` rather than reading the document during render: this runs in a
 * static export, where the first pass happens on the server with no document
 * at all, and where starting `false` would hold back the very first load. The
 * effect corrects it immediately for the rarer case of a page opened straight
 * into a background tab.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  return visible;
}

/**
 * Runs `job` on an interval, but only while the page is visible — and runs it
 * once immediately whenever there is a reason to.
 *
 * There are three moments a job has to run, and collapsing them into this hook
 * is the whole point. Callers used to pair a plain mount effect with a timer,
 * which fired *both* on arrival: two identical requests every load and every
 * time the subject changed, the second aborting the first. One code path for
 * the initial fetch and the refresh is the fix, not a guard bolted onto two.
 *
 *   mount            — nothing has run yet, so it runs
 *   `resetKey` moves — the subject changed and the old answer is about the
 *                      wrong thing, so it runs and the clock restarts
 *   back from hidden — it runs only if a whole period actually elapsed;
 *                      without that, flicking between tabs would fire a
 *                      request per flick, which is not a courtesy the free
 *                      services behind this deserve
 *
 * `job` receives an `AbortSignal`, aborted when a *later run supersedes it*
 * and at no other time. That restriction is the whole of the following bug,
 * so it is worth stating why rather than tidying it later.
 *
 * An earlier version also aborted in the effect's cleanup, to be tidy on
 * unmount. React's StrictMode double-invokes effects in development — mount,
 * unmount, mount — so that cleanup fired between the two: it cancelled the
 * only request, and the remount then declined to retry because `ranAt` had
 * just been stamped by the run it had cancelled. The app sat with no data for
 * a full minute and the timeline never appeared at all, since it does not
 * mount without one. Verified from the resource timing: one request, four
 * milliseconds, zero bytes transferred.
 *
 * So a run in flight is never cancelled from the outside. It may resolve
 * after unmount and set state on a component that is gone, which React 18
 * treats as a no-op — a far smaller price than a class of bug that appears
 * and disappears with the strictness setting.
 *
 * The job is read through a ref, so passing a fresh closure on every render
 * does not tear the timer down and rebuild it.
 */
export function useVisibleInterval(
  job: (signal: AbortSignal) => void,
  every: number,
  visible: boolean,
  resetKey?: unknown,
): void {
  const latest = useRef(job);
  latest.current = job;

  /** Epoch of the last run, kept across visibility changes so the catch-up is
   *  measured from the real last run rather than from the last mount. */
  const ranAt = useRef(0);

  /** The run currently out, kept only so the next one can cancel it. */
  const inFlight = useRef<AbortController | null>(null);

  /* Seeded with the first key, so mount is not mistaken for a change: mount
     runs anyway, on the elapsed check, and counting it twice is the bug this
     hook exists to remove. */
  const seen = useRef(resetKey);

  useEffect(() => {
    if (!visible) return;

    const changed = seen.current !== resetKey;
    seen.current = resetKey;

    const run = () => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      ranAt.current = Date.now();
      latest.current(controller.signal);
    };

    if (changed || Date.now() - ranAt.current >= every) run();

    const id = window.setInterval(run, every);
    /* The timer, and nothing else. See the note above on why an abort does
       not belong here. */
    return () => window.clearInterval(id);
  }, [visible, every, resetKey]);
}
