const basic = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const extended = new Set('^{}\\[~]|€');
export function smsLength(text = '') {
  let units = 0, unicode = false;
  for (const character of text) {
    if (basic.has(character)) units++;
    else if (extended.has(character)) units += 2;
    else { unicode = true; break; }
  }
  if (unicode) units = text.length;
  const single = unicode ? 70 : 160, multipart = unicode ? 67 : 153;
  return { unicode, units, segments: units ? units <= single ? 1 : Math.ceil(units / multipart) : 0 };
}
