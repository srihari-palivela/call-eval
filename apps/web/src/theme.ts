import {
  createTheme, MantineColorsTuple, Button, Card, Paper, Badge, SegmentedControl, Select,
  NumberInput, TextInput, ActionIcon, Tooltip, Table, CSSVariablesResolver, VariantColorsResolver, defaultVariantColorsResolver,
} from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';

// Monochrome ink scale (0 lightest … 9 near-black) and one warm accent for anything that needs attention.
const ink: MantineColorsTuple = ['#F5F5F5', '#E8E8E8', '#D4D4D4', '#BDBDBD', '#A3A3A3', '#737373', '#525252', '#404040', '#262626', '#0A0A0A'];
const accent: MantineColorsTuple = ['#FFF4E8', '#FDEBD8', '#F5C99A', '#F0A766', '#E8955A', '#D9772F', '#C2510F', '#9A3A0B', '#7A2A06', '#5A2405'];
// Neutral dark surfaces (Mantine's default dark scale is blue-tinted).
const dark: MantineColorsTuple = ['#D4D4D4', '#B8B8B8', '#8F8F8F', '#6E6E6E', '#454545', '#383838', '#2B2B2B', '#1E1E1E', '#171717', '#111111'];

export const theme = createTheme({
  primaryColor: 'ink',
  primaryShade: { light: 9, dark: 0 },
  // Filled ink is near-black in light mode and near-white in dark mode, so filled text flips with the scheme
  // through --filled-text (Mantine's autoContrast only checks the light-scheme shade).
  autoContrast: false,
  variantColorResolver: ((input) => {
    const r = defaultVariantColorsResolver(input);
    return input.variant === 'filled' ? { ...r, color: 'var(--filled-text)' } : r;
  }) as VariantColorsResolver,
  colors: { ink, accent, dark },
  fontFamily: "'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontFamilyMonospace: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  headings: { fontFamily: "'Hanken Grotesk', system-ui, sans-serif", fontWeight: '650' },
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: {
    Button: Button.extend({ defaultProps: { radius: 'xl' } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { radius: 'xl', variant: 'subtle', color: 'ink' } }),
    Card: Card.extend({ defaultProps: { radius: 'lg', withBorder: true, padding: 'lg' } }),
    Paper: Paper.extend({ defaultProps: { radius: 'lg' } }),
    Badge: Badge.extend({ defaultProps: { radius: 'xl', variant: 'light' } }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: 'xl' } }),
    Select: Select.extend({ defaultProps: { radius: 'md', allowDeselect: false, checkIconPosition: 'right' } }),
    NumberInput: NumberInput.extend({ defaultProps: { radius: 'md' } }),
    TextInput: TextInput.extend({ defaultProps: { radius: 'md' } }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true, openDelay: 150 } }),
    Table: Table.extend({ defaultProps: { verticalSpacing: 'sm', highlightOnHover: true } }),
  },
});

/** Per-scheme values: filled text, and a strong accent fill in both schemes. */
export const cssResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--filled-text': '#FFFFFF',
    '--mantine-color-accent-filled': '#9A3A0B',
    '--mantine-color-accent-filled-hover': '#7A2A06',
  },
  dark: {
    '--filled-text': '#0A0A0A',
    '--mantine-color-accent-filled': '#FF7A45',
    '--mantine-color-accent-filled-hover': '#FF8A50',
  },
});

export type Pal = ReturnType<typeof palette>;

function palette(dark: boolean) {
  return dark
    ? {
        dark, ink: '#F5F5F5', text2: '#B8B8B8', text3: '#9A9A9A', line: '#2E2E2E', soft: '#1E1E1E', track: '#2E2E2E',
        bar: '#E8E8E8', barMuted: '#8F8F8F', warn: '#F0A766', warnStrong: '#FF8A50', warnText: '#FDBA8C', warnSoft: '#3A2416', hl: '#33261A',
        thin: ['#262626', '#A3A3A3'],
        scale: { exc: ['#F5F5F5', '#0A0A0A'], goodHi: ['#8F8F8F', '#0A0A0A'], goodLo: ['#3A3A3A', '#F5F5F5'], nrHi: ['#6B3E17', '#FDE7CF'], nrLo: ['#C66A26', '#0A0A0A'], fail: ['#FF7A45', '#0A0A0A'] },
        series: { eot: '#8F8F8F', llm: '#F5F5F5', tool: '#FF8A50', tts: '#5E5E5E', a: '#E8E8E8', b: '#8F8F8F' },
      }
    : {
        dark, ink: '#0A0A0A', text2: '#525252', text3: '#6B6B6B', line: '#E8E8E8', soft: '#F5F5F5', track: '#EDEDED',
        bar: '#171717', barMuted: '#A3A3A3', warn: '#C2510F', warnStrong: '#C2510F', warnText: '#7A2A06', warnSoft: '#FDF1E6', hl: '#FFF4E8',
        thin: ['#EDEDED', '#525252'],
        scale: { exc: ['#171717', '#FFFFFF'], goodHi: ['#BDBDBD', '#0A0A0A'], goodLo: ['#E5E5E5', '#0A0A0A'], nrHi: ['#F5C99A', '#0A0A0A'], nrLo: ['#E8955A', '#0A0A0A'], fail: ['#9A3A0B', '#FFFFFF'] },
        series: { eot: '#A3A3A3', llm: '#171717', tool: '#C2510F', tts: '#D4D4D4', a: '#171717', b: '#BDBDBD' },
      };
}

export function usePal(): Pal {
  const scheme = useComputedColorScheme('light', { getInitialValueInEffect: false });
  return palette(scheme === 'dark');
}

/** Six-step score colour: Fail · Needs review (low/high) · Good (low/high) · Excellent. */
export function scoreColor(p: Pal, v: number): [string, string] {
  if (v >= 85) return p.scale.exc as [string, string];
  if (v >= 78) return p.scale.goodHi as [string, string];
  if (v >= 70) return p.scale.goodLo as [string, string];
  if (v >= 60) return p.scale.nrHi as [string, string];
  if (v >= 50) return p.scale.nrLo as [string, string];
  return p.scale.fail as [string, string];
}

export type BandName = 'Excellent' | 'Good' | 'Needs review' | 'Fail';
export function bandOf(v: number): { name: BandName; color: string; variant: string; action: string } {
  if (v >= 85) return { name: 'Excellent', color: 'ink', variant: 'filled', action: 'Use as a reference call.' };
  if (v >= 70) return { name: 'Good', color: 'ink', variant: 'light', action: 'No action.' };
  if (v >= 50) return { name: 'Needs review', color: 'accent', variant: 'light', action: 'Sample for coaching or a prompt fix.' };
  return { name: 'Fail', color: 'accent', variant: 'filled', action: 'Review every call; every gated call lands here.' };
}
