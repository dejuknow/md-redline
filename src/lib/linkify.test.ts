import { describe, expect, it } from 'vitest';
import { linkify } from './linkify';

const links = (text: string) =>
  linkify(text)
    .filter((s) => s.kind === 'link')
    .map((s) => (s.kind === 'link' ? s.href : ''));

describe('linkify', () => {
  it('returns one text segment when there is no link', () => {
    expect(linkify('no links here')).toEqual([{ kind: 'text', text: 'no links here' }]);
  });

  it('returns nothing for empty text', () => {
    expect(linkify('')).toEqual([]);
  });

  it('splits text around an https link', () => {
    expect(linkify('see https://example.com/a?b=1 for more')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: ' for more' },
    ]);
  });

  it('keeps long query strings and fragments intact', () => {
    const url = 'https://docs.google.com/spreadsheets/d/abc/edit?gid=1716497150#gid=1716497150';
    expect(links(`this spreadsheet? ${url}`)).toEqual([url]);
  });

  it('round-trips the input text', () => {
    const text = 'a (https://x.com/a_(b)) and www.y.org, then http://z.io.\nnext line';
    expect(
      linkify(text)
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
  });

  it('trims sentence punctuation and closing quotes', () => {
    expect(links('go to https://example.com.')).toEqual(['https://example.com']);
    expect(links('really? https://example.com/x?!')).toEqual(['https://example.com/x']);
    expect(links('"https://example.com",')).toEqual(['https://example.com']);
  });

  it('drops an unbalanced closing paren but keeps a balanced one', () => {
    expect(links('(see https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  it('gives www links an https href but keeps their text', () => {
    expect(linkify('www.example.com')).toEqual([
      { kind: 'link', text: 'www.example.com', href: 'https://www.example.com' },
    ]);
  });

  it('finds several links, including one per line', () => {
    expect(links('https://a.com\nhttps://b.com and http://c.com')).toEqual([
      'https://a.com',
      'https://b.com',
      'http://c.com',
    ]);
  });

  it('ignores a scheme with no host and a www inside a word', () => {
    expect(links('https:// is a scheme')).toEqual([]);
    expect(links('foowww.example.com')).toEqual([]);
  });

  it('leaves a www. with no host as text', () => {
    expect(linkify('use www.. later')).toEqual([{ kind: 'text', text: 'use www.. later' }]);
    expect(links('www.) or www.!?')).toEqual([]);
  });

  it('stops at markdown autolink and code-span delimiters', () => {
    expect(links('see <https://x.com>')).toEqual(['https://x.com']);
    expect(links('see `https://x.com`')).toEqual(['https://x.com']);
  });

  it('trims typographic quotes and CJK punctuation', () => {
    expect(links('\u201Chttps://x.com\u201D')).toEqual(['https://x.com']);
    expect(links('https://x.com\u3002')).toEqual(['https://x.com']);
    expect(links('\uFF08https://x.com/a\uFF09')).toEqual(['https://x.com/a']);
  });

  it('links a scheme right after punctuation but not after a letter', () => {
    expect(links('Done.https://x.com')).toEqual(['https://x.com']);
    expect(links('see:https://x.com')).toEqual(['https://x.com']);
    expect(links('xhttps://x.com')).toEqual([]);
  });

  it('does not link the www. host of an email address', () => {
    expect(links('mail me@www.example.com')).toEqual([]);
  });

  it('splits two links joined by a comma', () => {
    expect(links('https://a.com,https://b.com')).toEqual(['https://a.com', 'https://b.com']);
  });

  it('keeps a URL nested in a query string inside its link', () => {
    const url = 'https://www.google.com/url?q=https://x.com/a&sa=D';
    expect(links(url)).toEqual([url]);
  });

  it('ignores other schemes', () => {
    expect(links('javascript:alert(1) mailto:a@b.com ftp://x.com')).toEqual([]);
  });
});
