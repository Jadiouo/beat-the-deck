import { strings } from './shell/strings.ts';

/**
 * 進入點。外殼（標題、牌桌、對局、結算）在 T4 實作；
 * 骨架階段只把標題畫出來，讓 `npm run dev`、`npm run build`
 * 與端到端的煙霧測試有東西可以看。
 */
const app = document.querySelector<HTMLElement>('#app');

if (app !== null) {
  const heading = document.createElement('h1');
  heading.textContent = strings.title;
  heading.dataset['testid'] = 'title';

  const tagline = document.createElement('p');
  tagline.textContent = strings.tagline;

  const notice = document.createElement('p');
  notice.textContent = strings.skeletonNotice;

  app.append(heading, tagline, notice);
}
