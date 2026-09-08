import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';
import { TranslateModule } from '@ngx-translate/core';
import { BehaviorSubject, of } from 'rxjs';

import { HeaderComponent } from './header.component';
import { LanguageService } from '../../service/language.service';
import { WalletService } from '../../service/wallet.service';
import { ObsDeskService } from '../../service/obs-desk.service';

// Relayed from ObscuraMarket/agent-obs with the header change it describes: the header is Console, Trade, Agent,
// Docs and Roadmap. Rewards, Cards and Yield live in the console (their routes stay for deep links), Referral is
// gone, and the Console link follows the connected wallet: live when the desk's door lets that wallet in, greyed out
// with the site's own Soon treatment otherwise.
describe('HeaderComponent', () => {
  let component: HeaderComponent;
  let fixture: ComponentFixture<HeaderComponent>;
  const address$ = new BehaviorSubject<string | null>(null);
  const invited = new Set<string>(['0x1111111111111111111111111111111111111111']);

  beforeEach(() => {
    address$.next(null);
    TestBed.configureTestingModule({
      declarations: [HeaderComponent],
      imports: [CommonModule, FormsModule, RouterTestingModule, TranslateModule.forRoot()],
      providers: [
        {
          provide: LanguageService,
          useValue: {
            initializeLanguage: () => undefined,
            changeLanguage: () => undefined
          }
        },
        { provide: WalletService, useValue: { address$, get address() { return address$.value; } } },
        { provide: ObsDeskService, useValue: { door: (a: string) => of({ ok: true, open: invited.has(a.toLowerCase()) }) } }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    });
    fixture = TestBed.createComponent(HeaderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('lists Console, Trade, Agent, Docs and Roadmap on desktop and mobile, and none of the pages that live in the console', () => {
    const texts = Array.from(root().querySelectorAll('.nav-links a, .nav-menu-items a') as NodeListOf<HTMLAnchorElement>)
      .map((a) => a.textContent?.replace(/\s+/g, ' ').trim());

    const once = ['Soon Console', 'Trade', 'Agent', 'Docs', 'Roadmap'];
    expect(texts).toEqual([...once, ...once]);
    ['Rewards', 'Cards', 'Yield', 'Referral'].forEach((gone) => expect(texts.join(' ')).not.toContain(gone));
  });

  it('greys the Console item out with no wallet connected: no destination, a Soon badge, the coming-soon treatment', () => {
    const desktop = root().querySelector('[data-testid="nav-console"]');
    const mobile = root().querySelector('[data-testid="mobile-console"]');

    expect(desktop?.getAttribute('href')).toBeNull();
    expect(mobile?.getAttribute('href')).toBeNull();
    expect(desktop?.classList).toContain('coming-soon');
    expect(desktop?.classList).not.toContain('is-live');
    expect(mobile?.classList).toContain('coming-soon-mobile');
    expect(desktop?.querySelector('.soon-tag')?.textContent?.trim()).toBe('Soon');
    expect(mobile?.querySelector('.soon-tag-mobile')?.textContent?.trim()).toBe('Soon');
  });

  it('lights the Console link for a connected wallet the desk lets in, and greys it again when that wallet leaves', () => {
    address$.next('0x1111111111111111111111111111111111111111');
    fixture.detectChanges();
    expect(component.consoleOpen).toBeTrue();
    expect(root().querySelector('[data-testid="nav-console"]')?.getAttribute('href')).toBe('/console');
    expect(root().querySelector('[data-testid="mobile-console"]')?.getAttribute('href')).toBe('/console');
    expect(root().querySelectorAll('.soon-tag, .soon-tag-mobile').length).toBe(0, 'no Soon badge is left once the console is open');

    address$.next(null);
    fixture.detectChanges();
    expect(component.consoleOpen).toBeFalse();
    expect(root().querySelector('[data-testid="nav-console"]')?.getAttribute('href')).toBeNull();
  });

  it('keeps the Console item greyed for a connected wallet the desk does not let in', () => {
    address$.next('0x2222222222222222222222222222222222222222');
    fixture.detectChanges();
    expect(component.consoleOpen).toBeFalse();
    expect(root().querySelector('[data-testid="nav-console"]')?.classList).toContain('coming-soon');
  });

  it('routes desktop and mobile Trade actions to the application', () => {
    const tradeLinks = Array.from(root().querySelectorAll('a') as NodeListOf<HTMLAnchorElement>)
      .filter((a) => a.textContent?.trim() === 'Trade');

    expect(tradeLinks.length).toBe(2);
    tradeLinks.forEach((link) => expect(link.getAttribute('href')).toBe('/app'));
  });

  it('makes Console the only Soon item', () => {
    const dead = Array.from(root().querySelectorAll('.nav-link.coming-soon:not(.is-live)') as NodeListOf<HTMLElement>);

    expect(dead.length).toBe(1);
    expect(dead[0].getAttribute('data-testid')).toBe('nav-console');
  });

  function root(): HTMLElement { return fixture.nativeElement as HTMLElement; }
});
