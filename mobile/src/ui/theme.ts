import { useColorScheme } from 'react-native';

const light = {
  background: '#FAF7F2',
  card: '#FFFFFF',
  border: '#E8E2D9',
  text: '#1D1B19',
  muted: '#6F6A64',
  accent: '#E4572E',
  onAccent: '#FFFFFF',
  accentSoft: '#FCE6DE',
  danger: '#B3261E',
  ok: '#2E7D4F',
};

const dark: typeof light = {
  background: '#141210',
  card: '#1F1C19',
  border: '#34302B',
  text: '#F3EFEA',
  muted: '#A59E96',
  accent: '#F26A43',
  onAccent: '#1A0F0B',
  accentSoft: '#3A231B',
  danger: '#F2B8B5',
  ok: '#7FD4A0',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
