import { Check } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { tr } from '@/lib/i18n'
import {
  DARK_THEMES,
  LIGHT_THEMES,
  alpha,
  type Appearance,
  type Theme,
  type ThemeMode,
} from '@/lib/appearance'
import { cn } from '@/lib/utils'

type AppearanceSettingsProps = {
  appearance: Appearance
  resolvedMode: ThemeMode
  onUpdate: (patch: Partial<Appearance>) => void
  onSelectTheme: (id: string) => void
}

/** A miniature window painted with the palette, plus its name. */
function ThemeCard({
  theme,
  active,
  onSelect,
}: {
  theme: Theme
  active: boolean
  onSelect: () => void
}) {
  const { colors } = theme
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={theme.name}
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border text-left transition-colors',
        active
          ? 'border-ring ring-2 ring-ring/30'
          : 'border-border hover:border-ring/50',
      )}
    >
      <div className="space-y-1.5 p-3" style={{ background: colors.card }}>
        <div className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-8 rounded-full"
            style={{ background: alpha(colors.foreground, 0.18) }}
          />
          <span
            className="h-1.5 w-4 rounded-full"
            style={{ background: alpha(colors.foreground, 0.1) }}
          />
        </div>
        <span
          className="block h-1.5 w-24 rounded-full"
          style={{
            background: active
              ? colors.accent
              : alpha(colors.foreground, 0.45),
          }}
        />
        <div className="flex gap-1.5 pt-2">
          {colors.swatches.map((swatch) => (
            <span
              key={swatch}
              className="size-2 rounded-full"
              style={{ background: swatch }}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span className="truncate text-xs font-medium text-foreground">
          {theme.name}
        </span>
        {active && (
          <Check
            className="size-3.5 shrink-0"
            style={{ color: colors.accent }}
          />
        )}
      </div>
    </button>
  )
}

function ThemeGrid({
  themes,
  selected,
  onSelectTheme,
}: {
  themes: readonly Theme[]
  selected: string
  onSelectTheme: (id: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {themes.map((theme) => (
        <ThemeCard
          key={theme.id}
          theme={theme}
          active={theme.id === selected}
          onSelect={() => onSelectTheme(theme.id)}
        />
      ))}
    </div>
  )
}

export function AppearanceSettings({
  appearance,
  resolvedMode,
  onUpdate,
  onSelectTheme,
}: AppearanceSettingsProps) {
  return (
    <div className="space-y-7">
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {tr("跟随系统切换浅色 / 深色主题")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tr("跟随系统时，浅色与深色各自使用下面所选的外观。")}
            </p>
          </div>
          <Switch
            checked={appearance.followSystem}
            onCheckedChange={(checked: boolean) =>
              onUpdate({ followSystem: checked })
            }
            aria-label={tr("跟随系统切换浅色 / 深色主题")}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-medium text-muted-foreground">
          {tr("浅色外观")}
          {resolvedMode === "light" && (
            <span className="ml-2 text-[11px] text-foreground">
              {tr("使用中")}
            </span>
          )}
        </h2>
        <ThemeGrid
          themes={LIGHT_THEMES}
          selected={appearance.light}
          onSelectTheme={onSelectTheme}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-medium text-muted-foreground">
          {tr("深色外观")}
          {resolvedMode === "dark" && (
            <span className="ml-2 text-[11px] text-foreground">
              {tr("使用中")}
            </span>
          )}
        </h2>
        <ThemeGrid
          themes={DARK_THEMES}
          selected={appearance.dark}
          onSelectTheme={onSelectTheme}
        />
      </section>

      <section className="space-y-2 border-t border-border pt-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {tr("半透明窗口")}
            </p>
          </div>
          <Switch
            checked={appearance.translucency}
            onCheckedChange={(checked: boolean) =>
              onUpdate({ translucency: checked })
            }
            aria-label={tr("半透明窗口")}
          />
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {tr("窗口呈现磨砂半透明背景；系统关闭透明效果时会自动切换为不透明。")}
        </p>
      </section>
    </div>
  )
}
