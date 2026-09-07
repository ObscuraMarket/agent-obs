import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';
import { TranslateModule } from '@ngx-translate/core';

import { HeaderComponent } from './header.component';
import { LanguageService } from '../../service/language.service';

// Relayed from ObscuraMarket/agent-obs with the header change it describes: the referral section is gone, and the
// OBS console has its place first in the header, greyed out with the site's own Soon treatment until it opens.
// Trade, Rewards, Cards, Yield, Agent, Docs and Roadmap keep their links.
describe('HeaderComponent', () => {
  let component: HeaderComponent;
  let fixture: ComponentFixture<HeaderComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [HeaderComponent],
      imports: [FormsModule, RouterTestingModule, TranslateModule.forRoot()],
      providers: [
        {
          provide: LanguageService,
          useValue: {
            initializeLanguage: () => undefined,
            changeLanguage: () => undefined
          }
        }
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

  it('lists Console first, then the site\'s own pages, on desktop and mobile, and no Referral', () => {
    const texts = Array.from(root().querySelectorAll('.nav-links a, .nav-menu-items a') as NodeListOf<HTMLAnchorElement>)
      .map((a) => a.textContent?.replace(/\s+/g, ' ').trim());

    const once = ['Soon Console', 'Trade', 'Rewards', 'Cards', 'Soon Yield', 'Agent', 'Docs', 'Roadmap'];
    expect(texts).toEqual([...once, ...once]);
    expect(texts.join(' ')).not.toContain('Referral');
  });

  it('greys the Console item out on desktop and mobile: no destination, a Soon badge, the coming-soon treatment', () => {
    const desktop = root().querySelector('[data-testid="nav-console"]');
    const mobile = root().querySelector('[data-testid="mobile-console"]');

    expect(desktop?.getAttribute('href')).toBeNull();
    expect(mobile?.getAttribute('href')).toBeNull();
    expect(desktop?.classList).toContain('coming-soon');
    expect(desktop?.classList).not.toContain('is-live');
    expect(mobile?.classList).toContain('coming-soon-mobile');
    expect(mobile?.classList).not.toContain('is-live');
    expect(desktop?.querySelector('.soon-tag')?.textContent?.trim()).toBe('Soon');
    expect(mobile?.querySelector('.soon-tag-mobile')?.textContent?.trim()).toBe('Soon');
  });

  it('routes desktop and mobile Trade actions to the application', () => {
    const tradeLinks = Array.from(root().querySelectorAll('a') as NodeListOf<HTMLAnchorElement>)
      .filter((a) => a.textContent?.trim() === 'Trade');

    expect(tradeLinks.length).toBe(2);
    tradeLinks.forEach((link) => expect(link.getAttribute('href')).toBe('/app'));
  });

  it('keeps Yield clickable with its Soon badge', () => {
    const desktop = root().querySelector('[data-testid="nav-yield"]');
    const mobile = root().querySelector('[data-testid="mobile-yield"]');

    expect(desktop?.getAttribute('href')).toBe('/yield');
    expect(mobile?.getAttribute('href')).toBe('/yield');
    expect(desktop?.classList).toContain('is-live');
    expect(mobile?.classList).toContain('is-live');
  });

  it('makes Console the only Soon item without a destination', () => {
    const dead = Array.from(root().querySelectorAll('.nav-link.coming-soon:not(.is-live)') as NodeListOf<HTMLElement>);

    expect(dead.length).toBe(1);
    expect(dead[0].getAttribute('data-testid')).toBe('nav-console');
  });

  function root(): HTMLElement { return fixture.nativeElement as HTMLElement; }
});
