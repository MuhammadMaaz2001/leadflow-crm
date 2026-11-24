export { resolveRange } from './dates';
export const addDaysSafe = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
