import { createI18n } from 'vue-i18n';
import en from './en';
import mk from './mk';

export const messages = { mk, en };
export type Locale = keyof typeof messages;
const saved = (typeof localStorage !== 'undefined' && (localStorage.getItem('domar.locale') as Locale | null)) || 'mk';
export const i18n = createI18n({ legacy: false, locale: saved, fallbackLocale: 'en', messages });
export function setLocale(l: Locale) {
  i18n.global.locale.value = l;
  try { localStorage.setItem('domar.locale', l); } catch { /* ignore */ }
}
