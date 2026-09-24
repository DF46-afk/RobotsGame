/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { clamp, lerp } from './util.js';

/* ==========================================================================
 * === MATH LIB =============================================================
 * Flat Float32Array column-major matrices (glTF/WebGL convention).
 * Nothing here allocates: every function writes into a caller-owned out array.
 * ==========================================================================*/
const MAT4_ID = () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const V3 = (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]);
const Q4 = (x = 0, y = 0, z = 0, w = 1) => new Float32Array([x, y, z, w]);

/** Vec3 ops (out-variants avoid garbage). */
const vec3 = {
  set(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; },
  copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  add(o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
  sub(o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
  scale(o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
  madd(o, a, b, s) { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; },
  dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
  cross(o, a, b) {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
    o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx; return o;
  },
  len(a) { return Math.hypot(a[0], a[1], a[2]); },
  len2(a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; },
  norm(o, a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return vec3.scale(o, a, 1 / l); },
  lerp(o, a, b, t) {
    o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o;
  },
  dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); },
  /** Closest point on segment ab to p; writes it into o and returns the
   *  normalised direction (p - closest) so callers can push bodies apart. */
  closestOnSeg(o, p, a, b) {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const l2 = abx * abx + aby * aby + abz * abz;
    let t = l2 > 1e-9 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2 : 0;
    t = clamp(t, 0, 1);
    o[0] = a[0] + abx * t; o[1] = a[1] + aby * t; o[2] = a[2] + abz * t;
    return vec3.norm(_s.v5, vec3.sub(_s.v4, p, o));
  },
  dist2(a, b) { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; },
  transform(o, m, v) { // mat4 * vec3 (point)
    const x = v[0], y = v[1], z = v[2];
    o[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    o[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    o[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return o;
  },
  transformDir(o, m, v) { // mat4 * vec3 (direction, ignores translation)
    const x = v[0], y = v[1], z = v[2];
    o[0] = m[0] * x + m[4] * y + m[8] * z;
    o[1] = m[1] * x + m[5] * y + m[9] * z;
    o[2] = m[2] * x + m[6] * y + m[10] * z;
    return o;
  }
};

/** Quaternion ops. Layout [x,y,z,w]. */
const quat = {
  set(o, x, y, z, w) { o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },
  copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
  ident(o) { return quat.set(o, 0, 0, 0, 1); },
  norm(o, a) {
    let l = Math.hypot(a[0], a[1], a[2], a[3]); if (l === 0) return quat.ident(o);
    l = 1 / l; return quat.set(o, a[0] * l, a[1] * l, a[2] * l, a[3] * l);
  },
  /** Hamilton product o = a*b (o may alias neither unless careful). */
  mul(o, a, b) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    o[0] = aw * bx + ax * bw + ay * bz - az * by;
    o[1] = aw * by - ax * bz + ay * bw + az * bx;
    o[2] = aw * bz + ax * by - ay * bx + az * bw;
    o[3] = aw * bw - ax * bx - ay * by - az * bz;
    return o;
  },
  conjugate(o, a) { return quat.set(o, -a[0], -a[1], -a[2], a[3]); },
  fromAxisAngle(o, ax, ay, az, ang) {
    const h = ang * 0.5, s = Math.sin(h), l = Math.hypot(ax, ay, az) || 1;
    return quat.set(o, ax / l * s, ay / l * s, az / l * s, Math.cos(h));
  },
  fromEulerXYZ(o, rx, ry, rz) {
    const c1 = Math.cos(rx / 2), c2 = Math.cos(ry / 2), c3 = Math.cos(rz / 2);
    const s1 = Math.sin(rx / 2), s2 = Math.sin(ry / 2), s3 = Math.sin(rz / 2);
    return quat.set(o,
      s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3);
  },
  slerp(o, a, b, t) {
    let ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cs = ax * bx + ay * by + az * bz + aw * bw;
    if (cs < 0) { cs = -cs; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (cs > 0.9995) { // near-identical: fall back to normalised lerp
      o[0] = ax + (bx - ax) * t; o[1] = ay + (by - ay) * t;
      o[2] = az + (bz - az) * t; o[3] = aw + (bw - aw) * t;
      return quat.norm(o, o);
    }
    const th = Math.acos(clamp(cs, -1, 1)), st = Math.sin(th), s1 = Math.sin((1 - t) * th) / st, s2 = Math.sin(t * th) / st;
    o[0] = ax * s1 + bx * s2; o[1] = ay * s1 + by * s2; o[2] = az * s1 + bz * s2; o[3] = aw * s1 + bw * s2;
    return o;
  },
  /** rotate vector v by q into out */
  rotateVec(o, q, v) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const vx = v[0], vy = v[1], vz = v[2];
    const ix = qw * vx + qy * vz - qz * vy, iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx, iw = -qx * vx - qy * vy - qz * vz;
    o[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    o[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    o[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return o;
  }
};

/** Mat4 ops (column major, length 16). */
const mat4 = {
  ident(o) { o[0]=1;o[1]=0;o[2]=0;o[3]=0;o[4]=0;o[5]=1;o[6]=0;o[7]=0;o[8]=0;o[9]=0;o[10]=1;o[11]=0;o[12]=0;o[13]=0;o[14]=0;o[15]=1;return o; },
  copy(o, a) { for (let i = 0; i < 16; i++) o[i] = a[i]; return o; },
  /** o = a*b */
  mul(o, a, b) {
    const a00=a[0],a01=a[1],a02=a[2],a03=a[3],a10=a[4],a11=a[5],a12=a[6],a13=a[7],
          a20=a[8],a21=a[9],a22=a[10],a23=a[11],a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    for (let i = 0; i < 4; i++) {
      const b0 = b[i*4], b1 = b[i*4+1], b2 = b[i*4+2], b3 = b[i*4+3];
      o[i*4]   = b0*a00 + b1*a10 + b2*a20 + b3*a30;
      o[i*4+1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
      o[i*4+2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
      o[i*4+3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
    }
    return o;
  },
  perspective(o, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2); o.fill(0);
    o[0] = f / aspect; o[5] = f; o[11] = -1;
    const nf = 1 / (near - far); o[10] = (far + near) * nf; o[14] = 2 * far * near * nf;
    return o;
  },
  ortho(o, l, r, b, t, n, f) {
    o.fill(0);
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n); o[15] = 1;
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n);
    return o;
  },
  lookAt(o, eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let l = Math.hypot(zx, zy, zz); if (l < 1e-8) { zz = 1; l = 1; }
    zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); if (l < 1e-8) { xx = 1; xy = 0; xz = 0; l = 1; }
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    o[0]=xx; o[1]=yx; o[2]=zx; o[3]=0;
    o[4]=xy; o[5]=yy; o[6]=zy; o[7]=0;
    o[8]=xz; o[9]=yz; o[10]=zz; o[11]=0;
    o[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
    o[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
    o[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
    o[15]=1;
    return o;
  },
  compose(o, pos, quat_, scl) {
    const x=quat_[0],y=quat_[1],z=quat_[2],w=quat_[3];
    const x2=x+x, y2=y+y, z2=z+z;
    const xx=x*x2, xy=x*y2, xz=x*z2, yy=y*y2, yz=y*z2, zz=z*z2, wx=w*x2, wy=w*y2, wz=w*z2;
    const sx=scl?scl[0]:1, sy=scl?scl[1]:1, sz=scl?scl[2]:1;
    o[0]=(1-(yy+zz))*sx; o[1]=(xy+wz)*sx; o[2]=(xz-wy)*sx; o[3]=0;
    o[4]=(xy-wz)*sy; o[5]=(1-(xx+zz))*sy; o[6]=(yz+wx)*sy; o[7]=0;
    o[8]=(xz+wy)*sz; o[9]=(yz-wx)*sz; o[10]=(1-(xx+yy))*sz; o[11]=0;
    o[12]=pos[0]; o[13]=pos[1]; o[14]=pos[2]; o[15]=1;
    return o;
  },
  translate(o, a, v) {
    if (o !== a) mat4.copy(o, a);
    o[12] += a[0]*v[0] + a[4]*v[1] + a[8]*v[2];
    o[13] += a[1]*v[0] + a[5]*v[1] + a[9]*v[2];
    o[14] += a[2]*v[0] + a[6]*v[1] + a[10]*v[2];
    return o;
  },
  scale(o, a, v) {
    o[0]=a[0]*v[0]; o[1]=a[1]*v[0]; o[2]=a[2]*v[0]; o[3]=a[3]*v[0];
    o[4]=a[4]*v[1]; o[5]=a[5]*v[1]; o[6]=a[6]*v[1]; o[7]=a[7]*v[1];
    o[8]=a[8]*v[2]; o[9]=a[9]*v[2]; o[10]=a[10]*v[2]; o[11]=a[11]*v[2];
    o[12]=a[12]; o[13]=a[13]; o[14]=a[14]; o[15]=a[15];
    return o;
  },
  /* Post-multiply helpers: o = a * Rx(r). Written against temporaries FIRST
     so in-place use (o === a) is safe — no row/col aliasing bugs. */
  rotX(o, a, r) { const c=Math.cos(r), s=Math.sin(r);
    for (let j=0;j<4;j++){const y=a[4+j], z=a[8+j];
      o[j]=a[j]; o[4+j]=y*c+z*s; o[8+j]=z*c-y*s; o[12+j]=a[12+j];}
    return o; },
  rotY(o, a, r) { const c=Math.cos(r), s=Math.sin(r);
    for (let j=0;j<4;j++){const x=a[j], z=a[8+j];
      o[j]=x*c-z*s; o[4+j]=a[4+j]; o[8+j]=x*s+z*c; o[12+j]=a[12+j];}
    return o; },
  rotZ(o, a, r) { const c=Math.cos(r), s=Math.sin(r);
    for (let j=0;j<4;j++){const x=a[j], y=a[4+j];
      o[j]=x*c+y*s; o[4+j]=y*c-x*s; o[8+j]=a[8+j]; o[12+j]=a[12+j];}
    return o; },
  /** Rotation that carries unit vector `from` onto unit vector `to` (both
   *  normalised internally). Handles the antiparallel case gracefully. */
  fromTo(o, fx, fy, fz, tx, ty, tz) {
    let dl = Math.hypot(fx, fy, fz) || 1; fx /= dl; fy /= dl; fz /= dl;
    dl = Math.hypot(tx, ty, tz) || 1; tx /= dl; ty /= dl; tz /= dl;
    const d = fx * tx + fy * ty + fz * tz;
    if (d > 0.999999) return mat4.ident(o);
    if (d < -0.999999) {                       // 180 deg: pick any perp axis
      let ax = 1, ay = 0, az = 0;
      if (Math.abs(fx) > 0.9) { ax = 0; ay = 1; }
      const l = Math.hypot(ax, ay, az); ax /= l; ay /= l; az /= l;
      const hx = fy * az - fz * ay, hy = fz * ax - fx * az, hz = fx * ay - fy * ax;
      void hx; void hy; void hz;
      // 180deg rotation about axis perpendicular to f: R = 2*outer(a,a)-I
      o.fill(0);
      o[0] = 2 * ax * ax - 1; o[5] = 2 * ay * ay - 1; o[10] = 2 * az * az - 1;
      o[1] = o[4] = 2 * ax * ay; o[2] = o[8] = 2 * ax * az; o[6] = o[9] = 2 * ay * az;
      o[15] = 1;
      return o;
    }
    // Rodrigues construction from the half-angle vector h = normalize(f+t):
    // cos(theta) = 2*(f·h)^2 - 1, axis = normalize(f x h), sin = |f x h|/(f·h... )
    let hx = fx + tx, hy = fy + ty, hz = fz + tz;
    const hl = Math.hypot(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;
    const fh = fx * hx + fy * hy + fz * hz;            // cos(theta/2)
    const c = 2 * fh * fh - 1;                         // cos(theta)
    // axis = normalize(cross(f, h)) (parallel to cross(f, t))
    let ax = fy * hz - fz * hy, ay = fz * hx - fx * hz, az = fx * hy - fy * hx;
    const al = Math.hypot(ax, ay, az);
    if (al < 1e-6) return mat4.ident(o);
    ax /= al; ay /= al; az /= al;
    const s = al * 2 * fh;                             // sin(theta) = 2 sin(t/2)cos(t/2)
    const t1 = 1 - c;
    o[0] = c + ax * ax * t1;      o[1] = ay * ax * t1 + az * s; o[2] = az * ax * t1 - ay * s;      o[3] = 0;
    o[4] = ax * ay * t1 - az * s; o[5] = c + ay * ay * t1;      o[6] = az * ay * t1 + ax * s;      o[7] = 0;
    o[8] = ax * az * t1 + ay * s; o[9] = ay * az * t1 - ax * s; o[10] = c + az * az * t1;         o[11] = 0;
    o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
    return o;
  },
  transpose(o, a) {
    if (o === a) { let t; t=a[1];o[1]=a[4];o[4]=t; t=a[2];o[2]=a[8];o[8]=t; t=a[6];o[6]=a[9];o[9]=t;
      t=a[3];o[3]=a[12];o[12]=t; t=a[7];o[7]=a[13];o[13]=t; t=a[11];o[11]=a[14];o[14]=t; return o; }
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c*4+r] = a[r*4+c];
    return o;
  },
  /** general 4x4 inverse; returns null-ish (identity) if singular */
  invert(o, a) {
    const a00=a[0],a01=a[1],a02=a[2],a03=a[3],a10=a[4],a11=a[5],a12=a[6],a13=a[7],
          a20=a[8],a21=a[9],a22=a[10],a23=a[11],a30=a[12],a31=a[13],a32=a[14],a33=a[15];
    const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10, b03=a01*a12-a02*a11,
          b04=a01*a13-a03*a11, b05=a02*a13-a03*a12, b06=a20*a31-a21*a30, b07=a20*a32-a22*a30,
          b08=a20*a33-a23*a30, b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
    let det = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if (!det) { mat4.ident(o); return o; }
    det = 1 / det;
    o[0]=(a11*b11-a12*b10+a13*b09)*det; o[1]=(a02*b10-a01*b11-a03*b09)*det;
    o[2]=(a31*b05-a32*b04+a33*b03)*det; o[3]=(a22*b04-a21*b05-a23*b03)*det;
    o[4]=(a12*b08-a10*b11-a13*b07)*det; o[5]=(a00*b11-a02*b08+a03*b07)*det;
    o[6]=(a32*b02-a30*b05-a33*b01)*det; o[7]=(a20*b05-a22*b02+a23*b01)*det;
    o[8]=(a10*b10-a11*b08+a13*b06)*det; o[9]=(a01*b08-a00*b10-a03*b06)*det;
    o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det;
    o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det;
    o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det;
    return o;
  },
  /** extract rotation-only quaternion from upper 3x3 (orthonormalised) */
  toQuat(o, m) {
    const m00=m[0],m01=m[1],m02=m[2],m10=m[4],m11=m[5],m12=m[6],m20=m[8],m21=m[9],m22=m[10];
    const tr = m00 + m11 + m22;
    let s, x, y, z, w;
    if (tr > 0) { s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
    else if (m00 > m11 && m00 > m22) { s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
    else if (m11 > m22) { s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
    else { s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
    return quat.norm(o, quat.set(o, x, y, z, w));
  }
};

/** Scratch pool — reused every frame so the loop never allocates. */
const _s = {
  m1: MAT4_ID(), m2: MAT4_ID(), m3: MAT4_ID(), m4: MAT4_ID(), mTmp: MAT4_ID(),
  v1: V3(), v2: V3(), v3: V3(), v4: V3(), v5: V3(),
  q1: Q4(), q2: Q4(), q3: Q4()
};


export { MAT4_ID, V3, mat4, quat, vec3 };
