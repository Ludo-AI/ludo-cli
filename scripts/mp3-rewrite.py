# Rewrites LAME layer III streams into kinds no common encoder writes, for
# the MP3 corpus (scripts/mp3-corpus-make.mjs). Each keeps the stream valid
# and changes as little as it can; the first frame (LAME's Info tag) is
# left alone.
#
#   intensity1 in out      MPEG-1 joint stereo: sets the intensity bit. The
#                          scale factors read the same in MPEG-1, so the
#                          right channel's become intensity positions as
#                          they are.
#   intensity2 in out seed [t5]
#                          MPEG-2/2.5 joint stereo from `lame --nores`: sets
#                          the intensity bit and rewrites the right
#                          channel's scale factors as random legal intensity
#                          positions (below 2^slen - 1) in the intensity
#                          slen tables; with t5, in the last one, whose
#                          scalefac_compress is >= 500. Huffman data kept.
#   mixed in out           From `lame --nores`: short-block granules become
#                          mixed blocks, the scale factors re-laid (one slen1
#                          value fewer in MPEG-1, three fewer in the first
#                          LSF partition). Region 0 is 36 lines either way,
#                          so the Huffman data decodes to the same values.
#   noswitch in out        Start and stop granules become normal long
#                          blocks, in the side info only (same bit length;
#                          region 2 takes region 1's table): a stream that
#                          jumps between long and short windows.
import sys, random

KB = {1: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320], 0: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]}
NSF = [[[6,5,5,5],[9,9,9,9],[6,9,9,9]], [[6,5,7,3],[9,9,12,6],[6,9,12,6]], [[11,10,0,0],[18,18,0,0],[15,18,0,0]],
       [[7,7,7,0],[12,12,12,0],[6,15,12,0]], [[6,6,6,3],[12,9,9,6],[6,12,9,6]], [[8,8,5,0],[15,12,9,0],[6,18,9,0]]]
SLEN1 = [0,0,0,0,3,1,1,1,2,2,2,3,3,3,4,4]

def frames(d):
    """(offset, size) of each layer III frame, walked by header sizes."""
    i = 0
    while i + 4 <= len(d) and d[i] == 0xff and (d[i+1] & 0xe0) == 0xe0:
        mpeg1 = (d[i+1] >> 3) & 1
        v25 = not ((d[i+1] >> 4) & 1)
        rate = [44100, 48000, 32000][(d[i+2] >> 2) & 3] >> (0 if mpeg1 else 1) >> (1 if v25 else 0)
        size = (1152 if mpeg1 else 576) * KB[mpeg1][d[i+2] >> 4] * 125 // rate + ((d[i+2] >> 1) & 1)
        yield i, size, mpeg1, rate
        i += size

class Reader:
    def __init__(s, b, pos): s.b, s.pos = b, pos
    def get(s, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((s.b[s.pos >> 3] >> (7 - (s.pos & 7))) & 1)
            s.pos += 1
        return v

class Writer:
    def __init__(s): s.bits = []
    def put(s, v, n):
        for k in range(n - 1, -1, -1): s.bits.append((v >> k) & 1)
    def tobytes(s, size):
        assert len(s.bits) <= size * 8, (len(s.bits), size * 8)
        out = bytearray(size)
        for k, b in enumerate(s.bits):
            if b: out[k >> 3] |= 0x80 >> (k & 7)
        return out

def slen_lsf(sfc):
    if sfc < 400: return [(sfc >> 4) // 5, (sfc >> 4) % 5, (sfc % 16) >> 2, sfc % 4], 0
    if sfc < 500:
        sfc -= 400
        return [(sfc >> 2) // 5, (sfc >> 2) % 5, sfc % 4, 0], 1
    sfc -= 500
    return [sfc // 3, sfc % 3, 0, 0], 2

def read_frame(frame, mpeg1, nch):
    """Side info and each granule's main data bits (needs main_data_begin 0)."""
    r = Reader(frame, 32 + (0 if frame[1] & 1 else 16))
    si = {}
    if mpeg1:
        si['mdb'] = r.get(9); si['priv'] = r.get(5 if nch == 1 else 3); si['scfsi'] = [r.get(4) for _ in range(nch)]
    else:
        si['mdb'] = r.get(8); si['priv'] = r.get(1 if nch == 1 else 2)
    assert si['mdb'] == 0, 'needs a stream made with lame --nores'
    grs = []
    for _ in range((2 if mpeg1 else 1) * nch):
        g = {'p23': r.get(12), 'bv': r.get(9), 'gg': r.get(8), 'sfc': r.get(4 if mpeg1 else 9), 'ws': r.get(1)}
        if g['ws']:
            g['bt'] = r.get(2); g['mx'] = r.get(1); g['ts'] = [r.get(5), r.get(5)]; g['sbg'] = [r.get(3) for _ in range(3)]
        else:
            g['ts'] = [r.get(5) for _ in range(3)]; g['r0'] = r.get(4); g['r1'] = r.get(3)
        if mpeg1: g['pre'] = r.get(1)
        g['ss'] = r.get(1); g['c1'] = r.get(1)
        grs.append(g)
    mains = [[r.get(1) for _ in range(g['p23'])] for g in grs]
    return si, grs, mains

def write_frame(frame, size, mpeg1, nch, si, grs, mains, b3):
    w = Writer()
    for b in frame[:3]: w.put(b, 8)
    w.put(b3, 8)
    if not (frame[1] & 1): w.put(0, 16)
    if mpeg1:
        w.put(0, 9); w.put(si['priv'], 5 if nch == 1 else 3)
        for s in si['scfsi']: w.put(s, 4)
    else:
        w.put(0, 8); w.put(si['priv'], 1 if nch == 1 else 2)
    for g in grs:
        w.put(g['p23'], 12); w.put(g['bv'], 9); w.put(g['gg'], 8); w.put(g['sfc'], 4 if mpeg1 else 9); w.put(g['ws'], 1)
        if g['ws']:
            w.put(g['bt'], 2); w.put(g['mx'], 1)
            for t in g['ts']: w.put(t, 5)
            for t in g['sbg']: w.put(t, 3)
        else:
            for t in g['ts']: w.put(t, 5)
            w.put(g['r0'], 4); w.put(g['r1'], 3)
        if mpeg1: w.put(g['pre'], 1)
        w.put(g['ss'], 1); w.put(g['c1'], 1)
    for m in mains: w.bits += m
    return w.tobytes(size)

def intensity1(d):
    d = bytearray(d)
    for n, (i, size, mpeg1, rate) in enumerate(frames(d)):
        assert mpeg1
        if n and (d[i+3] & 0xc0) == 0x40: d[i+3] |= 0x10
    return d

def intensity2(d, seed, t5):
    rnd = random.Random(seed)
    out = bytearray()
    end = 0
    for n, (i, size, mpeg1, rate) in enumerate(frames(d)):
        frame = d[i:i+size]
        end = i + size
        if n == 0 or (frame[3] & 0xc0) != 0x40:
            out += frame
            continue
        assert not mpeg1
        si, grs, mains = read_frame(frame, False, 2)
        g = grs[1]
        tindex = (2 if g['mx'] else 1) if g['ws'] and g['bt'] == 2 else 0
        sl, t2 = slen_lsf(g['sfc'])
        part2 = sum(a * b for a, b in zip(sl, NSF[t2][tindex]))
        part3 = mains[1][part2:]
        free = size * 8 - 32 - 17 * 8 - grs[0]['p23'] - grs[1]['p23'] + part2
        nsf = NSF[5 if t5 else 3][tindex]
        bits = 2 if t5 else 3
        used = sum(nsf[:2]) if t5 else sum(nsf[:3])
        while bits and bits * used > free: bits -= 1
        if t5:
            S, slen = 244 + 3 * bits + min(bits, 2), [bits, min(bits, 2), 0, 0]
        else:
            S, slen = bits * 36 + bits * 6 + bits, [bits, bits, bits, 0]
        w = Writer()
        for k in range(4):
            for _ in range(nsf[k]):
                if slen[k]: w.put(rnd.randrange((1 << slen[k]) - 1), slen[k])
        g['sfc'] = 2 * S + rnd.randrange(2)
        g['p23'] = len(w.bits) + len(part3)
        mains[1] = w.bits + part3
        out += write_frame(frame, size, False, 2, si, grs, mains, frame[3] | 0x10)
    return out + d[end:]

def mixed(d):
    out = bytearray()
    end = 0
    for n, (i, size, mpeg1, rate) in enumerate(frames(d)):
        frame = d[i:i+size]
        end = i + size
        nch = 1 if (frame[3] >> 6) == 3 else 2
        if n == 0 or rate == 8000:
            out += frame
            continue
        si, grs, mains = read_frame(frame, mpeg1, nch)
        for k, g in enumerate(grs):
            if not (g['ws'] and g['bt'] == 2 and not g['mx']): continue
            if mpeg1:
                drop = SLEN1[g['sfc']]
            else:
                sl, t2 = slen_lsf(g['sfc'])
                drop = (NSF[t2][1][0] - NSF[t2][2][0]) * sl[0]
            mains[k] = mains[k][drop:]
            g['p23'] = len(mains[k])
            g['mx'] = 1
        out += write_frame(frame, size, mpeg1, nch, si, grs, mains, frame[3])
    return out + d[end:]

def noswitch(d):
    d = bytearray(d)
    def getb(pos, n):
        v = 0
        for k in range(n): v = (v << 1) | ((d[(pos + k) >> 3] >> (7 - ((pos + k) & 7))) & 1)
        return v
    def putb(pos, v, n):
        for k in range(n):
            q = pos + k
            if (v >> (n - 1 - k)) & 1: d[q >> 3] |= 0x80 >> (q & 7)
            else: d[q >> 3] &= ~(0x80 >> (q & 7)) & 0xff
    for n, (i, size, mpeg1, rate) in enumerate(list(frames(d))):
        if n == 0: continue
        nch = 1 if (d[i+3] >> 6) == 3 else 2
        p = (i + 4) * 8 + (0 if d[i+1] & 1 else 16)
        p += (9 + (5 if nch == 1 else 3) + 4 * nch) if mpeg1 else (8 + (1 if nch == 1 else 2))
        for _ in range((2 if mpeg1 else 1) * nch):
            q = p + 12 + 9 + 8 + (4 if mpeg1 else 9)
            if getb(q, 1) and getb(q + 1, 2) in (1, 3):
                t0, t1 = getb(q + 4, 5), getb(q + 9, 5)
                putb(q, 0, 1)
                putb(q + 1, t0, 5); putb(q + 6, t1, 5); putb(q + 11, t1, 5); putb(q + 16, 7, 4); putb(q + 20, 7, 3)
            p += 59 if mpeg1 else 63
    return d

cmd, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(src, 'rb').read()
if cmd == 'intensity1': res = intensity1(data)
elif cmd == 'intensity2': res = intensity2(data, int(sys.argv[4]), len(sys.argv) > 5 and sys.argv[5] == 't5')
elif cmd == 'mixed': res = mixed(data)
elif cmd == 'noswitch': res = noswitch(data)
else: sys.exit('unknown command ' + cmd)
open(dst, 'wb').write(res)
