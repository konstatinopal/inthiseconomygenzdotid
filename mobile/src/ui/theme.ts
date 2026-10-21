import { useColorScheme } from 'react-native';

// Same visual language as the web app: soft surfaces, a blue accent, and
// colour only where money needs attention.
const light = {
  bg: '#F2F3F6',
  surface: '#FFFFFF',
  surface2: '#F3F4F7',
  border: '#E4E6EB',
  text: '#16181D',
  text2: '#5D626E',
  text3: '#9AA0AB',
  accent: '#2F7BF5',
  accentSoft: '#E7F0FF',
  onAccent: '#FFFFFF',
  pos: '#149A4B',
  posSoft: '#DEF7E8',
  posStrong: '#18B45C',
  neg: '#E2484D',
  negSoft: '#FDE8E9',
  warn: '#A96B00',
  warnSoft: '#FFF3C9',
  shadow: 'rgba(17, 24, 39, 0.08)',
};

const dark: typeof light = {
  bg: '#0E1014',
  surface: '#1C2027',
  surface2: '#232830',
  border: '#2C323B',
  text: '#EEF0F4',
  text2: '#B0B6C2',
  text3: '#7D8492',
  accent: '#4D8EFF',
  accentSoft: '#1B2A45',
  onAccent: '#FFFFFF',
  pos: '#4CCF85',
  posSoft: '#16301F',
  posStrong: '#1E9E55',
  neg: '#FF6F73',
  negSoft: '#3A1C1E',
  warn: '#F2BF4A',
  warnSoft: '#3A2F12',
  shadow: 'rgba(0, 0, 0, 0.4)',
};

export type Palette = typeof light;

export function useTheme(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const radius = { sm: 10, md: 14, lg: 20, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
