/*
 * dwg2dxf-safe — LibreDWG로 DWG를 읽어 DXF로 쓰는 변환기 (GPLv3)
 *
 * LibreDWG 0.14의 dwg2dxf는 ACAD_PROXY_ENTITY(철근 설계 프로그램 등 외부 플러그인
 * 객체)를 DXF로 쓰다가 세그폴트로 죽고, 그 뒤 엔티티가 전부 잘린다.
 * 여기서는
 *   1) 읽은 뒤 프록시 엔티티를 UNKNOWN_ENT로 표시해 DXF 쓰기에서 건너뛰고
 *   2) 프록시 그래픽(AutoCAD가 화면에 그리는 대체 그림) 중 선·원·문자를 해독해
 *      일반 LINE/LWPOLYLINE/CIRCLE/ARC/TEXT로 ENTITIES 끝에 끼워 넣는다.
 *
 * 사용법: dwg2dxf-safe 입력.dwg 출력.dxf
 * stderr 마지막 줄에 "PROXY_SKIPPED <개수> PROXY_DRAWN <그린 도형 수>"를 출력한다.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dwg.h>
#include <dwg_api.h>

/* LibreDWG 0.14 src/bits.h 의 Bit_Chain (공개 헤더에 없음) */
typedef struct _bit_chain
{
  unsigned char *chain;
  size_t size;
  size_t byte;
  unsigned char bit;
  unsigned char opts;
  Dwg_Version_Type version;
  Dwg_Version_Type from_version;
  FILE *fh;
  BITCODE_RS codepage;
} Bit_Chain;

EXPORT int dwg_write_dxf (Bit_Chain *dat, Dwg_Data *dwg);

/* ───────────── 출력 버퍼 ───────────── */
typedef struct
{
  char *p;
  size_t n, cap;
} Buf;

static void
bput (Buf *b, const char *s)
{
  size_t l = strlen (s);
  if (b->n + l + 1 > b->cap)
    {
      b->cap = (b->n + l + 1) * 2;
      b->p = realloc (b->p, b->cap);
    }
  memcpy (b->p + b->n, s, l + 1);
  b->n += l;
}

static const char *NL = "\r\n"; /* LibreDWG 출력과 같은 줄바꿈 */

static void
gc (Buf *b, int code, const char *val)
{
  char t[64];
  snprintf (t, sizeof t, "%3d%s", code, NL);
  bput (b, t);
  bput (b, val);
  bput (b, NL);
}
static void
gcd (Buf *b, int code, double v)
{
  char t[64];
  snprintf (t, sizeof t, "%.12g", v);
  gc (b, code, t);
}
static void
gci (Buf *b, int code, long v)
{
  char t[64];
  snprintf (t, sizeof t, "%ld", v);
  gc (b, code, t);
}

/* ───────────── 프록시 그래픽 해독 ───────────── */
static uint32_t
rl (const unsigned char *p)
{
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16
         | (uint32_t)p[3] << 24;
}
static double
rd (const unsigned char *p)
{
  double d;
  memcpy (&d, p, 8);
  return d;
}

/* UTF-16LE(0 종료) → UTF-8. 읽은 바이트 수(종료 0 포함)를 돌려준다. */
static size_t
u16to8 (const unsigned char *s, size_t max, char *out, size_t outmax)
{
  size_t i = 0, o = 0;
  while (i + 1 < max)
    {
      unsigned c = s[i] | s[i + 1] << 8;
      i += 2;
      if (!c)
        break;
      if (c >= 0xD800 && c < 0xDC00 && i + 1 < max)
        {
          unsigned c2 = s[i] | s[i + 1] << 8;
          i += 2;
          c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        }
      if (o + 5 >= outmax)
        break;
      if (c < 0x80)
        out[o++] = (char)c;
      else if (c < 0x800)
        {
          out[o++] = (char)(0xC0 | c >> 6);
          out[o++] = (char)(0x80 | (c & 0x3F));
        }
      else if (c < 0x10000)
        {
          out[o++] = (char)(0xE0 | c >> 12);
          out[o++] = (char)(0x80 | (c >> 6 & 0x3F));
          out[o++] = (char)(0x80 | (c & 0x3F));
        }
      else
        {
          out[o++] = (char)(0xF0 | c >> 18);
          out[o++] = (char)(0x80 | (c >> 12 & 0x3F));
          out[o++] = (char)(0x80 | (c >> 6 & 0x3F));
          out[o++] = (char)(0x80 | (c & 0x3F));
        }
    }
  out[o] = 0;
  return i;
}

/* DXF 문자열 값에 줄바꿈이 섞이면 파일이 깨지므로 공백으로 바꾼다 */
static void
clean (char *s)
{
  for (; *s; s++)
    if (*s == '\r' || *s == '\n')
      *s = ' ';
}

static void
ent_head (Buf *b, const char *type, const char *layer, int color)
{
  gc (b, 0, type);
  gc (b, 100, "AcDbEntity");
  gc (b, 8, layer);
  gci (b, 62, color);
}

/* 프록시 하나의 그래픽을 DXF 엔티티로. 그린 도형 수를 돌려준다. */
static unsigned
proxy_to_dxf (Buf *b, const unsigned char *g, size_t gsz, const char *layer,
              int ent_color)
{
  unsigned drawn = 0;
  int color = ent_color; /* 256 = BYLAYER */
  if (!g || gsz < 8)
    return 0;
  uint32_t n = rl (g + 4);
  size_t p = 8;
  for (uint32_t k = 0; k < n && p + 8 <= gsz; k++)
    {
      uint32_t sz = rl (g + p), t = rl (g + p + 4);
      if (sz < 8 || p + sz > gsz)
        break;
      const unsigned char *d = g + p + 8;
      size_t dl = sz - 8;
      switch (t)
        {
        case 14: /* 하위 색 (ACI) */
          if (dl >= 4)
            {
              uint32_t c = rl (d);
              color = (c == 0 || c > 256) ? 256 : (int)c;
            }
          break;
        case 2: /* 원: 중심, 반지름, 법선 */
          if (dl >= 32)
            {
              ent_head (b, "CIRCLE", layer, color);
              gc (b, 100, "AcDbCircle");
              gcd (b, 10, rd (d));
              gcd (b, 20, rd (d + 8));
              gcd (b, 30, rd (d + 16));
              gcd (b, 40, rd (d + 24));
              drawn++;
            }
          break;
        case 4: /* 원호: 중심, 반지름, 법선, 시작벡터, 사잇각 */
          if (dl >= 88)
            {
              double sx = rd (d + 56), sy = rd (d + 64), sweep = rd (d + 80);
              double a0 = atan2 (sy, sx) * 180 / M_PI;
              double a1 = a0 + sweep * 180 / M_PI;
              if (sweep < 0)
                {
                  double tt = a0;
                  a0 = a1;
                  a1 = tt;
                }
              ent_head (b, "ARC", layer, color);
              gc (b, 100, "AcDbCircle");
              gcd (b, 10, rd (d));
              gcd (b, 20, rd (d + 8));
              gcd (b, 30, rd (d + 16));
              gcd (b, 40, rd (d + 24));
              gc (b, 100, "AcDbArc");
              gcd (b, 50, a0);
              gcd (b, 51, a1);
              drawn++;
            }
          break;
        case 6: /* 폴리라인: 점 개수, 점들 */
        case 7: /* 다각형 (닫힘) */
          if (dl >= 4)
            {
              uint32_t m = rl (d);
              if (m >= 2 && 4 + (size_t)m * 24 <= dl)
                {
                  ent_head (b, "LWPOLYLINE", layer, color);
                  gc (b, 100, "AcDbPolyline");
                  gci (b, 90, m);
                  gci (b, 70, t == 7 ? 1 : 0);
                  for (uint32_t i = 0; i < m; i++)
                    {
                      gcd (b, 10, rd (d + 4 + i * 24));
                      gcd (b, 20, rd (d + 4 + i * 24 + 8));
                    }
                  drawn++;
                }
            }
          break;
        case 38: /* 유니코드 문자2: 위치, 법선, 방향, 문자, 길이, raw, 높이, 폭 */
          if (dl >= 72 + 2)
            {
              char txt[2048];
              size_t used = u16to8 (d + 72, dl - 72, txt, sizeof txt);
              size_t q = 72 + ((used + 3) & ~(size_t)3);
              double h = 0, wf = 1;
              if (q + 24 <= dl)
                {
                  h = rd (d + q + 8);
                  wf = rd (d + q + 16);
                }
              if (!(h > 0) || h > 1e7)
                h = 1;
              if (!(wf > 0) || wf > 100)
                wf = 1;
              clean (txt);
              if (*txt)
                {
                  double ang = atan2 (rd (d + 56), rd (d + 48)) * 180 / M_PI;
                  ent_head (b, "TEXT", layer, color);
                  gc (b, 100, "AcDbText");
                  gcd (b, 10, rd (d));
                  gcd (b, 20, rd (d + 8));
                  gcd (b, 30, rd (d + 16));
                  gcd (b, 40, h);
                  gc (b, 1, txt);
                  if (ang != 0)
                    gcd (b, 50, ang);
                  if (wf != 1)
                    gcd (b, 41, wf);
                  gc (b, 100, "AcDbText");
                  drawn++;
                }
            }
          break;
        default:
          break; /* 색 외 속성·클립·행렬 등은 무시 */
        }
      p += sz;
    }
  return drawn;
}

/* ───────────── 파일에서 ENTITIES 끝(ENDSEC 앞)에 끼워 넣기 ───────────── */
static int
splice (const char *path, const Buf *ins)
{
  FILE *f = fopen (path, "rb");
  if (!f)
    return 1;
  fseek (f, 0, SEEK_END);
  long sz = ftell (f);
  fseek (f, 0, SEEK_SET);
  char *s = malloc ((size_t)sz + 1);
  if (!s || fread (s, 1, (size_t)sz, f) != (size_t)sz)
    {
      fclose (f);
      free (s);
      return 1;
    }
  fclose (f);
  s[sz] = 0;
  char *ents = strstr (s, "\nENTITIES");
  char *end = ents ? strstr (ents, "\nENDSEC") : NULL;
  if (!end)
    {
      free (s);
      return 1;
    }
  /* end는 "  0" 다음 줄의 \n. "  0" 줄의 시작으로 되돌린다 */
  char *zero = end - 1;
  while (zero > ents && *(zero - 1) != '\n')
    zero--;
  f = fopen (path, "wb");
  if (!f)
    {
      free (s);
      return 1;
    }
  fwrite (s, 1, (size_t)(zero - s), f);
  fwrite (ins->p, 1, ins->n, f);
  fwrite (zero, 1, (size_t)(s + sz - zero), f);
  fclose (f);
  free (s);
  return 0;
}

int
main (int argc, char **argv)
{
  Dwg_Data dwg;
  Bit_Chain dat;
  Buf extra = { 0 };
  int error;
  unsigned skipped = 0, drawn = 0;

  if (argc != 3)
    {
      fprintf (stderr, "usage: %s in.dwg out.dxf\n", argv[0]);
      return 2;
    }
  memset (&dwg, 0, sizeof dwg);
  memset (&dat, 0, sizeof dat);
  error = dwg_read_file (argv[1], &dwg);
  if (error >= DWG_ERR_CRITICAL)
    {
      fprintf (stderr, "READ ERROR 0x%x\n", error);
      return 1;
    }

  Dwg_Object *mspace = dwg_model_space_object (&dwg);
  for (BITCODE_BL i = 0; i < dwg.num_objects; i++)
    {
      Dwg_Object *o = &dwg.object[i];
      if (o->fixedtype != DWG_TYPE_PROXY_ENTITY)
        continue;
      Dwg_Object_Entity *ent = o->tio.entity;
      /* 모형공간에 직접 있는 프록시만 그린다 (블록 안 프록시는 위치 변환이 필요) */
      /* 소유자 핸들이 없거나 0이면 모형공간으로 본다 (LibreDWG의 DXF 출력과 같은 기준) */
      int in_ms = ent
                  && (!ent->ownerhandle || ent->ownerhandle->absolute_ref == 0
                      || (mspace
                          && ent->ownerhandle->absolute_ref
                                 == mspace->handle.value));
      if (ent && in_ms && ent->preview && ent->preview_size > 8)
        {
          int err = 0;
          char *ln = dwg_ent_get_layer_name (ent, &err);
          char layer[512];
          snprintf (layer, sizeof layer, "%s", (ln && !err) ? ln : "0");
          clean (layer);
          int col = ent->color.index ? ent->color.index : 256;
          drawn += proxy_to_dxf (&extra, ent->preview, ent->preview_size,
                                 layer, col);
        }
      o->fixedtype = DWG_TYPE_UNKNOWN_ENT;
      skipped++;
    }

  dat.version = dwg.header.version;
  dat.from_version = dwg.header.from_version;
  dat.fh = fopen (argv[2], "wb");
  if (!dat.fh)
    {
      fprintf (stderr, "WRITE ERROR %s\n", argv[2]);
      return 1;
    }
  error = dwg_write_dxf (&dat, &dwg);
  fclose (dat.fh);
  if (extra.n && splice (argv[2], &extra))
    fprintf (stderr, "Warning: proxy graphics not inserted\n");
  fprintf (stderr, "PROXY_SKIPPED %u PROXY_DRAWN %u\n", skipped, drawn);
  /* dwg_free는 손상 객체에서 죽을 수 있어 생략 (프로세스 종료로 해제) */
  return error >= DWG_ERR_CRITICAL ? 1 : 0;
}
