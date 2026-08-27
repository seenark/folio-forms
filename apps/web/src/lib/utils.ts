export const cn = (...values: (string | false | null | undefined)[]) =>
  values.filter(Boolean).join(" ");

export const formatDate = (value: string | undefined) => {
  if (!value) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value)
  );
};
