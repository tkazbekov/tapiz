import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'tapiz-auth-layout',
  template: `
    <div class="card">
      <div class="logo">
        <a routerLink="/">
          <img
            priority="true"
            ngSrc="/assets/svgs/tapiz-logo.svg"
            width="140"
            height="65"
            alt="Tapiz logo" />
        </a>
        <img
          priority="true"
          class="login-img"
          ngSrc="/assets/login-img.png"
          width="300"
          height="320"
          alt="" />
      </div>

      <h1>{{ heading() }}</h1>

      <ng-content />
    </div>
  `,
  styleUrl: './auth-layout.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgOptimizedImage, RouterLink],
})
export class AuthLayoutComponent {
  heading = input.required<string>();
}
