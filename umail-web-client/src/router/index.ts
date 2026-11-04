export type Route = 'inbox' | 'starred' | 'sent' | 'archive' | 'trash' | 'domain-info' | 'login' | 'otp' | 'signup';

export interface RouteConfig {
  pattern: RegExp;
  view: Route;
}

export class AppRouter extends EventTarget {
  private static instance: AppRouter;
  private routes: RouteConfig[] = [
    { pattern: /^app:\/\/inbox/, view: 'inbox' },
    { pattern: /^app:\/\/starred/, view: 'starred' },
    { pattern: /^app:\/\/sent/, view: 'sent' },
    { pattern: /^app:\/\/archive/, view: 'archive' },
    { pattern: /^app:\/\/trash/, view: 'trash' },
    { pattern: /^app:\/\/domain-info/, view: 'domain-info' },
    { pattern: /^app:\/\/login/, view: 'login' },
    { pattern: /^app:\/\/otp/, view: 'otp' },
    { pattern: /^app:\/\/signup/, view: 'signup' },
    // Standard Web & /umail subpath routes
    { pattern: /\/umail\/inbox/, view: 'inbox' },
    { pattern: /\/umail\/starred/, view: 'starred' },
    { pattern: /\/umail\/sent/, view: 'sent' },
    { pattern: /\/umail\/archive/, view: 'archive' },
    { pattern: /\/umail\/trash/, view: 'trash' },
    { pattern: /\/umail\/domain-info/, view: 'domain-info' },
    { pattern: /\/umail\/login/, view: 'login' },
    { pattern: /\/umail\/otp/, view: 'otp' },
    { pattern: /\/umail\/signup/, view: 'signup' },
    { pattern: /\/umail\/?$/, view: 'login' },
    { pattern: /^\/$/, view: 'login' }
  ];

  private constructor() {
    super();
    window.addEventListener('popstate', () => this.resolveRoute());
    window.addEventListener('hashchange', () => this.resolveRoute());
  }

  static get getInstance(): AppRouter {
    if (!AppRouter.instance) {
      AppRouter.instance = new AppRouter();
    }
    return AppRouter.instance;
  }

  navigate(path: string) {
    if (path.startsWith('app://')) {
      const sub = path.replace('app://', '');
      window.history.pushState({}, '', `/umail/${sub}`);
    } else {
      window.history.pushState({}, '', path);
    }
    this.resolveRoute();
  }

  resolveRoute() {
    const path = window.location.pathname;
    const matched = this.routes.find((r) => r.pattern.test(path));
    const view: Route = matched ? matched.view : 'login';

    this.dispatchEvent(
      new CustomEvent('route-changed', {
        detail: { view }
      })
    );
  }
}

export const router = AppRouter.getInstance;
