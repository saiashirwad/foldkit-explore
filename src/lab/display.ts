export const formatValue = (value: unknown, indentation?: number): string =>
  value === undefined
    ? 'undefined'
    : (JSON.stringify(
        value,
        (_key: string, child: unknown) =>
          typeof child === 'bigint'
            ? `${child}n`
            : child === undefined
              ? 'undefined'
              : child,
        indentation,
      ) ?? String(value))
