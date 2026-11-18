// Fetches community-submitted intro/outro segments from SponsorBlock (privacy-preserving hash prefix lookup).
const KIND = { intro: 'intro', outro: 'outro', preview: 'recap' };

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === 'sb') {
    fetchSegments(msg.videoId).then(send).catch(() => send([]));
    return true; // async response
  }
});

async function fetchSegments(id) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const url = 'https://sponsor.ajay.app/api/skipSegments/' + hex.slice(0, 4) +
    '?categories=' + encodeURIComponent('["intro","outro","preview"]') +
    '&actionTypes=' + encodeURIComponent('["skip"]');
  const res = await fetch(url);
  if (!res.ok) return [];
  const entry = (await res.json()).find(x => x.videoID === id);
  if (!entry) return [];
  return entry.segments.map(s => ({
    start: s.segment[0], end: s.segment[1], kind: KIND[s.category], src: 'SponsorBlock'
  }));
}
