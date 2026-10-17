export const BAHAMUT_CREATED_AT = Date.parse('2026-10-16T20:31:55+08:00') / 1000;

export const bahamutFloor = (id: string, text: string, floor = 1): string => `
<section class="c-section" id="post_${id}">
<a class="floor" data-floor="${floor}">${floor}</a>
<a class="userid" href="//home.gamer.com.tw/example">example</a>
<a class="edittime" data-mtime="2026-10-16 20:31:55">Edited yesterday</a>
<article class="c-article"><div class="c-article__content">${text}</div></article>
<div class="c-reply">Unrelated inline comment</div></section>`;

export const bahamutPager = (last: number): string =>
  `<p class="BH-pagebtnA"><a href="?page=${last}&amp;bsn=12345">${last}</a></p>`;

export const bahamutTopic = (
  id: string,
  options: { board?: string; sticky?: boolean; subboard?: string; title?: string } = {},
): string => `
<tr class="b-list__row${options.sticky === true ? ' b-list__row--sticky' : ''}">
<td><a href="B.php?bsn=${options.board ?? '12345'}&amp;subbsn=${options.subboard ?? '3'}" data-subbsn="${options.subboard ?? '3'}">Category</a>
<a class="b-list__main__link" href="C.php?bsn=${options.board ?? '12345'}&amp;snA=${id}"><p class="b-list__main__title" href="C.php?bsn=${options.board ?? '12345'}&amp;snA=${id}">${options.title ?? `Topic ${id}`}</p></a>
</td><td class="b-list__time">Last reply yesterday</td></tr>`;

export const bahamutBoard = (topics: string, lastPage = 1): string => `
<select onchange="Forum.B.orderBy(this.value)"><option value="1">Last reply</option><option value="2" selected>Creation</option></select>
<table class="b-list">${topics}<tr class="b-list__row"><td class="b-list_ad">Advertisement</td></tr></table>
${bahamutPager(lastPage)}`;
