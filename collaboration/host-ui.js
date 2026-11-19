// The host link is opened locally by Herdr. Teammate links contain only the room invite.
export function readHostEntry(url, storage) {
  const params = new URLSearchParams(url.hash.slice(1));
  const invite = params.get('invite') || '';
  const token = params.get('owner');
  const key = 'runespace.team.host';
  let owner = '';
  try {
    if (token && invite) storage.setItem(key, JSON.stringify({invite, token}));
    const previous = JSON.parse(storage.getItem(key) || 'null');
    if (previous?.invite === invite) owner = previous.token;
  } catch { /* session storage can be unavailable in a restricted browser */ }
  const clean = new URL(url);
  params.delete('owner');
  clean.hash = params.toString();
  return {invite, owner: token || owner, clean, hadOwner: !!token};
}

export function teamInvite(url, invite) {
  const share = new URL('/', url.origin);
  share.hash = new URLSearchParams({invite}).toString();
  return share.href;
}

export function createHerdrActions({session, post, toast}) {
  let busy = false;
  async function open(path, payload, success) {
    if (busy) return;
    const active = session();
    if (!active) return;
    busy = true;
    try {
      await post(path, payload, active.session);
      toast(success);
    } catch (error) {
      toast(error.message || 'Herdr could not open on the host desktop.');
    } finally {
      busy = false;
    }
  }
  return {
    chat(agent) {
      if (!session()?.canOpenChats) {
        toast(agent.name + ' · Agent conversations are available on the host’s Herdr desktop.');
        return;
      }
      return open('/api/agent-chat', {id:agent.id}, 'Conversation opened in Herdr.');
    }
  };
}
