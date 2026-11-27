/**
 * Appearance preferences: which palette to use in light and dark mode, whether
 * to follow the system's mode, and the translucent-window switch.
 *
 * A theme only carries the handful of base colors a palette is built from;
 * every derived token (borders, muted text, sidebar tints, charts) is computed
 * from those so a palette stays consistent without a wall of CSS blocks. The
 * variables are written inline on <html>, which overrides the fallback values
 * in index.css and keeps the `.dark` class (used by Tailwind's dark: variants)
 * in charge of the mode.
 */

export type ThemeMode = 'light' | 'dark'

export type ThemeColors = {
  background: string
  card: string
  sidebar: string
  foreground: string
  accent: string
  /** Four accent dots used by the theme card preview. */
  swatches: readonly [string, string, string, string]
}

export type Theme = {
  id: string
  name: string
  mode: ThemeMode
  colors: ThemeColors
}

export const LIGHT_THEMES: readonly Theme[] = [
  {
    id: 'paper',
    name: 'Paper',
    mode: 'light',
    colors: {
      background: '#FBFAF7',
      card: '#FFFFFF',
      sidebar: '#F5F3EE',
      foreground: '#17181C',
      accent: '#2B6F80',
      swatches: ['#2B6F80', '#7BA05B', '#C98B4B', '#A66371'],
    },
  },
  {
    id: 'nord-light',
    name: 'Nord Light',
    mode: 'light',
    colors: {
      background: '#ECEFF4',
      card: '#FFFFFF',
      sidebar: '#E5E9F0',
      foreground: '#2E3440',
      accent: '#5E81AC',
      swatches: ['#5E81AC', '#A3BE8C', '#EBCB8B', '#BF616A'],
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    colors: {
      background: '#EFF1F5',
      card: '#FFFFFF',
      sidebar: '#E6E9EF',
      foreground: '#4C4F69',
      accent: '#8839EF',
      swatches: ['#1E66F5', '#40A02B', '#DF8E1D', '#D20F39'],
    },
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    mode: 'light',
    colors: {
      background: '#FAF4ED',
      card: '#FFFBF5',
      sidebar: '#F2E9E1',
      foreground: '#575279',
      accent: '#907AA9',
      swatches: ['#56949F', '#286983', '#EA9D34', '#B4637A'],
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    colors: {
      background: '#FDF6E3',
      card: '#FEF9EC',
      sidebar: '#F5EFD9',
      foreground: '#586E75',
      accent: '#268BD2',
      swatches: ['#2AA198', '#859900', '#B58900', '#DC322F'],
    },
  },
  {
    id: 'one-light',
    name: 'One Light',
    mode: 'light',
    colors: {
      background: '#FAFAFA',
      card: '#FFFFFF',
      sidebar: '#F0F0F0',
      foreground: '#383A42',
      accent: '#4078F2',
      swatches: ['#0184BC', '#50A14F', '#C18401', '#E45649'],
    },
  },
]

export const DARK_THEMES: readonly Theme[] = [
  {
    id: 'ink',
    name: 'Ink',
    mode: 'dark',
    colors: {
      background: '#121316',
      card: '#1C1E23',
      sidebar: '#16181C',
      foreground: '#E8E9EC',
      accent: '#8FD0DD',
      swatches: ['#8FD0DD', '#A7C98B', '#E0AE72', '#D293A2'],
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    colors: {
      background: '#2E3440',
      card: '#3B4252',
      sidebar: '#2B303B',
      foreground: '#ECEFF4',
      accent: '#88C0D0',
      swatches: ['#88C0D0', '#A3BE8C', '#EBCB8B', '#BF616A'],
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    colors: {
      background: '#1A1B26',
      card: '#24283B',
      sidebar: '#16161E',
      foreground: '#C0CAF5',
      accent: '#7AA2F7',
      swatches: ['#7DCFFF', '#9ECE6A', '#E0AF68', '#F7768E'],
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    colors: {
      background: '#1E1E2E',
      card: '#313244',
      sidebar: '#181825',
      foreground: '#CDD6F4',
      accent: '#CBA6F7',
      swatches: ['#89B4FA', '#A6E3A1', '#F9E2AF', '#F38BA8'],
    },
  },
  {
    id: 'rose-pine-moon',
    name: 'Rosé Pine Moon',
    mode: 'dark',
    colors: {
      background: '#232136',
      card: '#2A273F',
      sidebar: '#1F1D2E',
      foreground: '#E0DEF4',
      accent: '#C4A7E7',
      swatches: ['#9CCFD8', '#3E8FB0', '#F6C177', '#EB6F92'],
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    mode: 'dark',
    colors: {
      background: '#282828',
      card: '#3C3836',
      sidebar: '#1D2021',
      foreground: '#EBDBB2',
      accent: '#83A598',
      swatches: ['#83A598', '#B8BB26', '#FABD2F', '#FB4934'],
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    colors: {
      background: '#002B36',
      card: '#073642',
      sidebar: '#00252E',
      foreground: '#93A1A1',
      accent: '#268BD2',
      swatches: ['#2AA198', '#859900', '#B58900', '#DC322F'],
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    mode: 'dark',
    colors: {
      background: '#282C34',
      card: '#2E333D',
      sidebar: '#21252B',
      foreground: '#ABB2BF',
      accent: '#61AFEF',
      swatches: ['#56B6C2', '#98C379', '#E5C07B', '#E06C75'],
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    mode: 'dark',
    colors: {
      background: '#171310',
      card: '#231D18',
      sidebar: '#120F0D',
      foreground: '#EDE3D6',
      accent: '#E0A458',
      swatches: ['#E0A458', '#D98A5F', '#C96F6F', '#8FA98F'],
    },
  },
]

export type Appearance = {
  followSystem: boolean
  /** The mode used when `followSystem` is off. */
  mode: ThemeMode
  light: string
  dark: string
  translucency: boolean
}

const STORAGE_KEY = 'sabir-appearance'
const LEGACY_THEME_KEY = 'sabir-theme'

export function systemMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function normalizeAppearance(
  value: Partial<Appearance> | null | undefined,
): Appearance {
  const light = LIGHT_THEMES.find((theme) => theme.id === value?.light)
  const dark = DARK_THEMES.find((theme) => theme.id === value?.dark)
  return {
    followSystem:
      typeof value?.followSystem === 'boolean' ? value.followSystem : true,
    mode:
      value?.mode === 'dark' || value?.mode === 'light'
        ? value.mode
        : systemMode(),
    light: light?.id ?? 'paper',
    dark: dark?.id ?? 'ink',
    translucency: value?.translucency === true,
  }
}

export function loadAppearance(): Appearance {
  if (typeof window === 'undefined') return normalizeAppearance(null)
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) return normalizeAppearance(JSON.parse(raw))
    // Older builds stored only the resolved light/dark choice.
    const legacy = window.localStorage.getItem(LEGACY_THEME_KEY)
    if (legacy === 'light' || legacy === 'dark') {
      return normalizeAppearance({ followSystem: false, mode: legacy })
    }
  } catch {
    // Corrupt storage: fall back to defaults.
  }
  return normalizeAppearance(null)
}

export function saveAppearance(appearance: Appearance): Appearance {
  const next = normalizeAppearance(appearance)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

export function resolveMode(appearance: Appearance): ThemeMode {
  return appearance.followSystem ? systemMode() : appearance.mode
}

export function themeFor(appearance: Appearance, mode: ThemeMode): Theme {
  const list = mode === 'dark' ? DARK_THEMES : LIGHT_THEMES
  const id = mode === 'dark' ? appearance.dark : appearance.light
  return list.find((theme) => theme.id === id) ?? list[0]
}

/** `#RRGGBB` → `rgba(r, g, b, alpha)`; used for the derived tints. */
export function alpha(hex: string, opacity: number): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  const safe = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1
  return `rgba(${r}, ${g}, ${b}, ${safe})`
}

/** The coss token set, derived from one palette. */
export function themeVars(theme: Theme): Record<string, string> {
  const { background, card, sidebar, foreground, accent, swatches } =
    theme.colors
  const dark = theme.mode === 'dark'
  return {
    '--background': background,
    '--foreground': foreground,
    '--card': card,
    '--card-foreground': foreground,
    '--popover': card,
    '--popover-foreground': foreground,
    '--primary': foreground,
    '--primary-foreground': background,
    '--secondary': alpha(foreground, dark ? 0.06 : 0.04),
    '--secondary-foreground': foreground,
    '--muted': alpha(foreground, dark ? 0.05 : 0.04),
    '--muted-foreground': `color-mix(in srgb, ${foreground} ${dark ? 55 : 58}%, ${background})`,
    '--accent': alpha(accent, 0.1),
    '--accent-foreground': accent,
    '--border': alpha(foreground, dark ? 0.08 : 0.09),
    '--input': alpha(foreground, dark ? 0.1 : 0.12),
    '--ring': accent,
    '--sidebar': sidebar,
    '--sidebar-foreground': `color-mix(in srgb, ${foreground} ${dark ? 60 : 64}%, ${sidebar})`,
    '--sidebar-accent': alpha(accent, dark ? 0.1 : 0.08),
    '--sidebar-accent-foreground': accent,
    '--sidebar-border': alpha(foreground, 0.07),
    '--sidebar-primary': foreground,
    '--sidebar-primary-foreground': background,
    '--sidebar-ring': accent,
    '--code': card,
    '--code-foreground': foreground,
    '--code-highlight': alpha(foreground, dark ? 0.06 : 0.04),
    '--chart-1': swatches[0],
    '--chart-2': swatches[1],
    '--chart-3': swatches[2],
    '--chart-4': swatches[3],
    '--chart-5': accent,
  }
}

/** Write the resolved palette onto <html>; returns the mode now in effect. */
export function applyAppearance(appearance: Appearance): ThemeMode {
  const mode = resolveMode(appearance)
  if (typeof document === 'undefined') return mode
  const theme = themeFor(appearance, mode)
  const root = document.documentElement
  for (const [name, value] of Object.entries(themeVars(theme))) {
    root.style.setProperty(name, value)
  }
  root.classList.toggle('dark', mode === 'dark')
  root.style.colorScheme = mode
  root.dataset.theme = theme.id
  root.dataset.lightTheme = appearance.light
  root.dataset.darkTheme = appearance.dark
  return mode
}
