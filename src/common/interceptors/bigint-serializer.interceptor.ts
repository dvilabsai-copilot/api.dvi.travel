// src/common/interceptors/bigint-serializer.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

// Recursively convert BigInt and Prisma Decimal to strings
function serializeBigInts(value: any): any {
  if (value === null || value === undefined) return value;

  const t = typeof value;

 // BigInt -> string
  if (t === "bigint") return value.toString();

 // Date must be handled explicitly (otherwise becomes {})
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }

 // Prisma Decimal without importing Prisma at runtime
  if (t === "object" && value?.constructor?.name === "Decimal") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(serializeBigInts);
  }

 // Only serialize "plain objects"; keep class instances as-is
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    const isPlain = proto === Object.prototype || proto === null;

    if (!isPlain) {
 // This prevents turning class instances / special objects into {}
      return value;
    }

    const out: any = {};
    for (const k of Object.keys(value)) {
      out[k] = serializeBigInts(value[k]);
    }
    return out;
  }

  return value;
}

@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => serializeBigInts(data)));
  }
}
