// Progress belongs to one named adventurer in this browser. Web Locks serialize
// independent tabs, while the simulation merges newer rewards from the same save.
const fresh = () => ({version: 1, hp: 10});
const decode = raw => {
  try { return JSON.parse(raw); } catch { return null; }
};

export function createAdventureProfile(sim, {storage, locks, merge, onError = () => {}}) {
  let active = null;
  const read = key => {
    try { return storage?.getItem(key) ?? null; } catch { return null; }
  };

  function save() {
    const state = active;
    const revision = sim.adventure.revision;
    if (!state || state.writing || revision === state.revision) return state?.writing;
    const local = sim.saveAdventure();
    const write = () => {
      const raw = read(state.key);
      const conflict = raw !== state.raw;
      const next = conflict ? merge(decode(state.raw), local, decode(raw)) : local;
      const encoded = JSON.stringify(next);
      if (!storage) throw Error('Storage unavailable');
      storage.setItem(state.key, encoded);
      state.raw = encoded;
      state.revision = revision;
      if (conflict && active === state) {
        const changed = sim.adventure.revision !== revision;
        sim.reconcileAdventure(changed ? merge(local, sim.saveAdventure(), next) : next);
        if (!changed) state.revision = sim.adventure.revision;
      }
    };
    state.writing = (locks ? locks.request(state.key, write) : Promise.resolve().then(write))
      .catch(() => {
        state.revision = revision;
        if (!state.warned) onError('This browser could not save your adventure.');
        state.warned = true;
      })
      .finally(() => {
        state.writing = null;
        if (active === state && sim.adventure.revision !== state.revision) save();
      });
    return state.writing;
  }

  function open(name) {
    const key = 'runespace.adventure.v1.' + name.trim().normalize('NFC');
    if (active?.key === key) return;
    save();
    const raw = read(key);
    sim.restoreAdventure(decode(raw) ?? fresh());
    active = {key, raw, revision: sim.adventure.revision, writing: null};
  }
  function refresh(key) {
    if (!active || active.key !== key || active.writing) return;
    if (active.revision !== sim.adventure.revision) { save(); return; }
    const raw = read(key);
    if (raw === active.raw) return;
    sim.reconcileAdventure(decode(raw) ?? fresh());
    active.raw = raw;
    active.revision = sim.adventure.revision;
  }
  return {
    open, save, refresh,
    close() { save(); active = null; },
    readGear() { return active && decode(read(active.key + '.gear')); },
    writeGear(gear) {
      if (!active) return;
      try { storage.setItem(active.key + '.gear', JSON.stringify(gear)); }
      catch { onError('This browser could not save your outfit.'); }
    },
  };
}
