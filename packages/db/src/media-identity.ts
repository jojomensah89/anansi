/** SQL shared with the hand-written migration; unknown hosts keep the full URL.
 * CDN query parameters select representations or authorize access to a path.
 *
 * TikTok serves one image from mirror hosts (p16-, p19-) at the same path, and
 * that path holds the image's hash, so its identity leaves the host out too.
 */
const host = "lower(substr(origin_url, 9, instr(substr(origin_url, 9), '/') - 1))";
const path = "CASE WHEN instr(origin_url, '?') > 0 THEN substr(origin_url, 1, instr(origin_url, '?') - 1) ELSE origin_url END";
export const MEDIA_IDENTITY_SQL = `CASE
 WHEN substr(origin_url, 1, 8) = 'https://' AND (${host} GLOB '*.tiktokcdn.com' OR ${host} GLOB '*.tiktokcdn-us.com') THEN 'tiktokcdn:' || substr((${path}), 8 + instr(substr(origin_url, 9), '/'))
 WHEN substr(origin_url, 1, 8) = 'https://' AND (${host} IN ('preview.redd.it', 'external-preview.redd.it') OR ${host} GLOB '*.cdninstagram.com' OR ${host} GLOB '*.fbcdn.net') THEN ${path}
 WHEN ${host} = 'pbs.twimg.com' THEN CASE
   WHEN lower(substr((${path}), -4)) IN ('.jpg', '.png') THEN substr((${path}), 1, length((${path})) - 4)
   WHEN lower(substr((${path}), -5)) IN ('.jpeg', '.webp') THEN substr((${path}), 1, length((${path})) - 5)
   ELSE ${path} END
 ELSE origin_url END`;
