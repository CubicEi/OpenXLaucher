interface PageTransitionProps {
  children: React.ReactNode;
}

export function PageTransition({ children }: PageTransitionProps) {
  return <div className="h-full w-full">{children}</div>;
}
