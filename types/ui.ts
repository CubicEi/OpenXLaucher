import type { ReactNode } from "react";

export type InstanceCard = {
  id: string;
  title: string;
  description: string;
  icon: ReactNode;
  href: string;
  stats: string[];
  colorFrom: string;
  colorTo: string;
  iconBgColor: string;
  iconColor: string;
};

export type SidebarTabConfig = {
  id: string;
  name: string;
  visible: boolean;
  canHide: boolean;
  order: number;
};

export type UIConfig = {
  sidebarTabs: SidebarTabConfig[];
};

export type Announcement = {
  id: string;
  title: string;
  content: string;
};

export type ViewType = "home" | "instance";
