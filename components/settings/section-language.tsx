"use client";

import { Globe2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettings, type AppLanguage } from "@/components/settings/settings-provider";
import { useI18n } from "@/components/i18n/use-i18n";

const COPY = {
  title: "settings.languageSection.title",
  description: "settings.languageSection.description",
  system: "settings.languageSection.systemLanguage",
  chinese: "settings.languageSection.chinese",
  english: "settings.languageSection.english",
} as const;

export function LanguageSection() {
  const { settings, update } = useSettings();
  const { language } = settings.general;
  const { t } = useI18n();

  return (
    <Card id="section-language" className="scroll-mt-4">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="size-4 text-primary" />
          {t(COPY.title)}
        </CardTitle>
        <CardDescription className="text-xs mt-1">{t(COPY.description)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select
          value={language}
          onValueChange={(value) => update("general", { language: value as AppLanguage })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh-CN">{t(COPY.chinese)}</SelectItem>
            <SelectItem value="en-US">{t(COPY.english)}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t(COPY.system)}</p>
      </CardContent>
    </Card>
  );
}
