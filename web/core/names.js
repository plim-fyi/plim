// What others see you as in a shared note when you haven't set a name: a
// character from Middle-earth, picked once per device and kept, so you don't
// turn into someone new every time you open a note. Your own name, once set,
// replaces it.

export const NAMES = [
  'Frodo', 'Sam', 'Merry', 'Pippin', 'Bilbo', 'Rosie', 'Farmer Maggot', 'Barliman',
  'Gandalf', 'Radagast', 'Tom Bombadil', 'Goldberry', 'Treebeard', 'Quickbeam', 'Beorn',
  'Aragorn', 'Arwen', 'Boromir', 'Faramir', 'Éowyn', 'Éomer', 'Théoden', 'Imrahil', 'Bergil',
  'Legolas', 'Galadriel', 'Celeborn', 'Elrond', 'Glorfindel', 'Haldir', 'Círdan', 'Lúthien', 'Beren',
  'Gimli', 'Thorin', 'Balin', 'Dwalin', 'Fíli', 'Kíli', 'Bombur', 'Bard', 'Gwaihir', 'Shadowfax',
];

const KEY = 'tiro-fallback-name';

/** This device's name from the list (chosen the first time; a new one each time if storage is unavailable). */
export function fallbackName(storage = globalThis.localStorage) {
  try {
    const kept = storage?.getItem(KEY);
    if (NAMES.includes(kept)) return kept;
  } catch {
    /* no storage: pick one for now */
  }
  const name = NAMES[crypto.getRandomValues(new Uint32Array(1))[0] % NAMES.length];
  try {
    storage?.setItem(KEY, name);
  } catch {
    /* not kept, then */
  }
  return name;
}
