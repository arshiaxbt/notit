import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';
import {FONT} from './tokens';

/** Bricolage Grotesque variable, latin, with the weight and width axes (the file the app ships). */
export const fontsReady = loadFont({
  family: FONT,
  url: staticFile('fonts/bricolage-grotesque-latin-wdth-normal.woff2'),
  weight: '200 800',
  stretch: '75% 100%',
  format: 'woff2',
});
