// Instructions shown in the Info tab.
//
// PLACEHOLDERS: search this file for [[ ]] - each one needs replacing with
// your own wording before the link goes to volunteers. The measurement
// protocol in particular is a sensible generic version, NOT your protocol.

export const INFO_HTML = `
<h2>How PeatProbe works</h2>
<p>PeatProbe records how deeply peat has burned after a wildfire. Your measurements
help build the first UK-wide picture of peat carbon loss from fire — something that
currently has to be estimated rather than measured.</p>

<div class="callout">
  <p><strong>Works with no signal.</strong> Download a field pack while you have wifi
  and the map, the fire perimeter and the recording form all keep working in the
  middle of nowhere. Your measurements upload when you get back to a connection.</p>
</div>

<h3>Before you go out</h3>
<ol>
  <li><strong>Add PeatProbe to your home screen.</strong> On iPhone: Share → Add to Home
  Screen. On Android: menu → Install app. This is not cosmetic — browsers can delete
  data belonging to sites that are not installed, and that would take your
  measurements with it.</li>
  <li><strong>Download the field pack</strong> for the fire you are visiting, from the
  <em>Packs</em> tab. Do this on wifi; a pack is typically 5–50 MB.</li>
  <li><strong>Check the pack shows "Offline ready"</strong> before you lose signal.</li>
  <li>Take a <strong>ruler or tape measure</strong>, a charged phone, and ideally a
  power bank. GPS drains batteries fast.</li>
</ol>

<h3>Taking a measurement</h3>
<div class="callout">
  <p><strong>[[ Replace this section with your own protocol. ]]</strong> What follows is
  a placeholder so the app is usable for testing.</p>
</div>
<ol>
  <li>Find a spot that is <strong>representative</strong> of the area around you — not the
  deepest hole you can find. Biased sampling toward dramatic spots is the single
  biggest risk to this dataset.</li>
  <li>Identify the <strong>pre-fire surface level</strong> using a reference: an unburnt
  edge, the base of surviving vegetation, or exposed roots.</li>
  <li>Measure straight down from that level to the current surface. Record in
  <strong>centimetres</strong>.</li>
  <li>Repeat at up to <strong>five</strong> points within roughly a two-metre radius and
  enter each reading separately. The app averages them for you, and the spread
  tells us how variable the burn was.</li>
  <li>Stand still for a moment before saving so the GPS settles. The app shows your
  accuracy — under ±10 m is good, over ±30 m gets flagged.</li>
</ol>

<h3>The photo</h3>
<p>A photo is required for every measurement, because it is how readings get checked
later. A good photo shows:</p>
<ul>
  <li>Your ruler or tape <strong>in the frame</strong>, against the surface being measured</li>
  <li>The reference level you measured from</li>
  <li>Enough surroundings to see the context</li>
</ul>
<p>Photos are shrunk on your phone before upload, so they will not eat your data
allowance.</p>

<h3>Staying safe</h3>
<div class="callout callout--danger">
  <p><strong>Burned peatland can stay dangerous long after a fire looks out.</strong>
  Peat can smoulder underground for weeks, leaving voids that collapse underfoot and
  ground that is still hot.</p>
</div>
<ul>
  <li>Do not visit a fire that is still burning or still being managed.</li>
  <li>Never go alone, and tell someone your route and expected return time.</li>
  <li>Test the ground ahead of you with a pole where the surface looks disturbed.</li>
  <li>Wear boots and carry water. Remember there is no phone signal — that is why the
  app works offline, but it also means you cannot call for help.</li>
  <li>Turn back if conditions or weather change. No measurement is worth a rescue.</li>
</ul>

<h3>Access and permission</h3>
<p>A fire showing on the map is <strong>not</strong> permission to walk onto it.</p>
<ul>
  <li><strong>Scotland:</strong> statutory access rights cover most land, but you must
  exercise them responsibly under the Scottish Outdoor Access Code.</li>
  <li><strong>England and Wales:</strong> access is limited to rights of way and mapped
  open access land. Much moorland is private and often actively managed.</li>
  <li><strong>Northern Ireland:</strong> access rights are considerably more limited —
  assume you need the landowner's permission.</li>
</ul>
<p>Always follow local signage, avoid the bird breeding season where restrictions
apply, and contact the landowner if in doubt. [[ Add your project's guidance and
any landowner contacts here. ]]</p>

<h3>Your data and privacy</h3>
<ul>
  <li>Measurements are stored <strong>on your device first</strong>, and uploaded only when
  you sync.</li>
  <li>What we record: location, depth readings, your photo, your notes, the name or
  initials you enter, and — if cloud sync is on — the Google account you signed in
  with.</li>
  <li><strong>Please do not photograph people</strong>, vehicle number plates, or anything
  that identifies an individual.</li>
  <li>Submissions are reviewed before being included in published data.</li>
  <li>[[ Add your data controller, retention period, ethics approval reference, and a
  contact address for data requests. This section is a legal requirement, not
  optional — check with your institution's data protection office. ]]</li>
</ul>

<h3>If something goes wrong</h3>
<ul>
  <li><strong>Map is blank offline</strong> — the pack for that fire was not downloaded, or
  you have wandered outside its area. Packs cover the fire plus about 2 km.</li>
  <li><strong>"Unsynced" count will not clear</strong> — you need a connection and to be
  signed in. Your data is safe in the meantime.</li>
  <li><strong>No GPS fix</strong> — move away from steep ground or dense cover, wait a
  minute, or place the point manually by tapping the map.</li>
  <li><strong>Running out of space</strong> — delete packs for fires you have finished with,
  from the Packs tab. Your measurements are never deleted with a pack.</li>
  <li>Still stuck: [[ your support email ]]</li>
</ul>

<h3>Map layers</h3>
<p>Tap <strong>Legend</strong> at the bottom right of the map to see what the colours
mean. Layers are toggled from the control at the top right.</p>
<ul>
  <li><strong>Land cover</strong> — CORINE 2018. Useful context, but 100 m resolution
  with a 25 ha minimum patch size, so small bogs will not show.</li>
  <li><strong>Burn severity</strong> — dNBR from Sentinel-2, available for the larger
  fires only. It measures how much the surface changed, <em>not</em> how deep the
  peat burned, and its thresholds come from forest studies rather than bog. Use
  it to spread your measurements across a range of severities — that is exactly
  the comparison this project needs.</li>
</ul>

<h3>Credits</h3>
<p>Fire perimeters from the <strong>European Forest Fire Information System (EFFIS)</strong>,
Copernicus Emergency Management Service. Land cover from <strong>CORINE Land Cover
2018</strong>, Copernicus / EEA. Burn severity derived from <strong>Sentinel-2</strong>,
Copernicus. Base map &copy; MapTiler and OpenStreetMap contributors. Built for
[[ your project / institution ]].</p>
`;
