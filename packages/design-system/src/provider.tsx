'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { dirOf, type DaftarLocale, type Direction } from './tokens';

export interface DaftarContextValue {
  locale: DaftarLocale;
  dir: Direction;
}

const DaftarContext = createContext<DaftarContextValue>({ locale: 'ar', dir: 'rtl' });

export function DaftarProvider(props: { locale: DaftarLocale; children: ReactNode }) {
  const dir = dirOf(props.locale);
  return <DaftarContext.Provider value={{ locale: props.locale, dir }}>{props.children}</DaftarContext.Provider>;
}

export function useDaftar(): DaftarContextValue {
  return useContext(DaftarContext);
}
