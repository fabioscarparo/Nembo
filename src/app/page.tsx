/**
 * The only route. A map that fills the viewport and nothing around it.
 *
 * `fixed inset-0` rather than normal document flow: the map owns its own
 * gestures and the page must not scroll or rubber-band underneath it. There is
 * no header, no nav and no chrome by design — everything the app can do is
 * reachable from the two pills the map itself mounts.
 */
import RadarMap from "@/components/RadarMap";

export default function Page() {
  return (
    <main className="fixed inset-0">
      <RadarMap />
    </main>
  );
}
