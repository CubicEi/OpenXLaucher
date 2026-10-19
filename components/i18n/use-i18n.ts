"use client";

import { useCallback } from "react";
import { useSettings, type AppLanguage } from "@/components/settings/settings-provider";
import zhCN from "@/components/i18n/locales/zh-CN.json";
import enUS from "@/components/i18n/locales/en-US.json";

type TranslationKeyOf<T> = {
  [Key in keyof T & string]: T[Key] extends string
    ? Key
    : T[Key] extends Record<string, unknown>
      ? `${Key}.${TranslationKeyOf<T[Key]>}`
      : never;
}[keyof T & string];

export type TranslationKey = TranslationKeyOf<typeof enUS>;
export type Translation = TranslationKey;
type TranslationValues = Record<string, string | number>;

const dictionaries: Record<AppLanguage, Record<string, unknown>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

function resolveTranslation(key: TranslationKey, language: AppLanguage): string | undefined {
  const value = key.split(".").reduce<unknown>(
    (current, segment) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined,
    dictionaries[language],
  );
  return typeof value === "string" ? value : undefined;
}

function interpolate(text: string, values?: TranslationValues): string {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (placeholder, name) =>
    values[name] === undefined ? placeholder : String(values[name]),
  );
}

/**
 * 统一的界面翻译入口。
 *
 * 新增界面文案时必须同时提供中文与英文，避免语言切换后出现未翻译文本。
 */
export function useI18n() {
  const { settings } = useSettings();
  const language = settings.general.language;
  const t = useCallback(
    (key: TranslationKey, values?: TranslationValues) =>
      interpolate(resolveTranslation(key, language) ?? key, values),
    [language],
  );

  return { language, isEnglish: language === "en-US", t };
}
