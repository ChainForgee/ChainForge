declare module 'jest-axe' {
  export const axe: any;
  export const toHaveNoViolations: any;
}

declare namespace jest {
  interface Matchers<R> {
    toHaveNoViolations(): R;
  }
}
