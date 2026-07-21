import { notFound } from 'next/navigation';
import { getRequestConfig } from 'next-intl/server';
import en from './messages/en.json';
import es from './messages/es.json';
import fr from './messages/fr.json';
import frCA from './messages/fr-CA.json';
import ptBR from './messages/pt-BR.json';
import sw from './messages/sw.json';

export const locales = ['en', 'es', 'fr', 'fr-CA', 'pt-BR', 'sw'] as const;
export type Locale = (typeof locales)[number];

const messages = {
  en,
  es,
  fr,
  'fr-CA': frCA,
  'pt-BR': ptBR,
  sw,
};

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = await requestLocale;

  if (!locale || !locales.includes(locale as any)) notFound();

  return {
    locale,
    messages: messages[locale as Locale],
  };
});
