'use client';

import { useEffect, useRef } from 'react';

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void },
  ) => string;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Loads Cloudflare's script once; later widgets reuse it. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    // Added by this page's own script, which the page's policy trusts
    // ('strict-dynamic'), so it needs no nonce of its own.
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('Turnstile did not load'));
    };
    script.onerror = () => {
      reject(new Error('Turnstile could not be reached'));
    };
    document.head.appendChild(script);
  });
}

/**
 * The CAPTCHA asked for after repeated failed sign-ins (§20.2). It is shown
 * only when the server asks, never up front: a person who types their
 * password right the first time never sees it.
 */
export function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widget: string | null = null;
    let live = true;
    void loadTurnstile().then(
      (api) => {
        if (!live || !box.current) return;
        widget = api.render(box.current, {
          sitekey: siteKey,
          callback: (token) => {
            onToken(token);
          },
          'expired-callback': () => {
            onToken(null);
          },
        });
      },
      () => {
        onToken(null);
      },
    );
    return () => {
      live = false;
      if (widget && window.turnstile) window.turnstile.remove(widget);
    };
  }, [siteKey, onToken]);
  return <div ref={box} />;
}
