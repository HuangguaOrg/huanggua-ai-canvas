# ArcReel playback code

The playback scheduler, preview track placement, audio synchronization, playback
hook and timeline types in this directory were ported from the user's local
ArcReel distribution (`frontend/src/components/canvas/edit` and its associated
hooks/types). The accompanying `LICENSE` preserves that distribution's GNU
Affero General Public License v3. The pure-function regression tests were ported
with these modules into `tests/studio/timeline`.

Local adaptations replace import aliases and integrate hash-verified Huanggua
library media URLs. Timeline persistence, rendering and draft packaging continue
to use the locally bundled engine through the scoped Huanggua desktop adapter.
Upstream hosted services are disabled; the original license and attribution remain.
