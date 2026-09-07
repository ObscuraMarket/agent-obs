import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';
import { TranslateModule } from '@ngx-translate/core';

import { HeaderComponent } from './header.component';
import { LanguageService } from '../../service/language.service';

// Relayed from ObscuraMarket/agent-obs with the header change it describes: Trade, Rewards, Cards and Yield are
// console views now (/trade, /rewards, /cards, /yield on the console page) and the referral section is gone, so the
// header lists Console, Agent, Docs and Roadmap. The four pages keep their routes for deep links.
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

  it('lists Console, Agent, Docs and Roadmap on desktop and mobile, and none of the pages that became console views', () => {
    const root = fixture.nativeElement as HTMLElement;
    const texts = Array.from(root.querySelectorAll('.nav-links a, .nav-menu-items a') as NodeListOf<HTMLAnchorElement>)
      .map((a) => a.textContent?.trim());

    expect(texts).toEqual(['Console', 'Agent', 'Docs', 'Roadmap', 'Console', 'Agent', 'Docs', 'Roadmap']);
    ['Trade', 'Rewards', 'Cards', 'Referral', 'Yield'].forEach((gone) => expect(texts).not.toContain(gone));
  });

  it('routes the Console item to the console page on desktop and mobile', () => {
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-testid="nav-console"]')?.getAttribute('href')).toBe('/console');
    expect(root.querySelector('[data-testid="mobile-console"]')?.getAttribute('href')).toBe('/console');
  });

  it('marks the Console item active on the console page', () => {
    component.setActiveLink('console');
    fixture.detectChanges();

    expect(root().querySelector('[data-testid="nav-console"]')?.classList).toContain('active');
  });

  it('carries no Soon badge now that Yield is a console view', () => {
    expect(root().querySelectorAll('.soon-tag, .soon-tag-mobile').length).toBe(0);
  });

  function root(): HTMLElement { return fixture.nativeElement as HTMLElement; }
});
