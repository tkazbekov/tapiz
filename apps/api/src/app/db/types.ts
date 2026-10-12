export type SetNonNullable<T> = { [K in keyof T]: NonNullable<T[K]> };
