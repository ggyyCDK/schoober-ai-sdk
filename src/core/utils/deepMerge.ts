/**
* 深度合并对象
* 递归合并两个对象，对于嵌套对象会进行深度合并而不是覆盖
* 
* @param target 目标对象（会被修改）
* @param source 源对象（用于合并）
* @returns 合并后的对象
* 
* @example
* ```typescript
* const target = { a: { b: 1, c: 2 } };
* const source = { a: { d: 3 } };
* const result = deepMerge(target, source);
* // result: { a: { b: 1, c: 2, d: 3 } }
* ```
*/
export function deepMerge<T extends Record<string, any>>(
    target: T,
    source: Partial<T> | undefined | null
): T {
    // 如果 source 为空，直接返回 target
    if (!source || typeof source !== 'object') {
        return target;
    }

    // 创建目标对象的副本，避免修改原对象
    const result = { ...target };

    // 遍历 source 的所有属性
    for (const key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) {
            continue;
        }

        const sourceValue = source[key];
        const targetValue = result[key];

        // 如果 source 的值是 null 或 undefined，跳过
        if (sourceValue === null || sourceValue === undefined) {
            continue;
        }

        // 如果 target 和 source 的值都是普通对象（不是数组、Date等），进行深度合并
        if (
            isPlainObject(targetValue) &&
            isPlainObject(sourceValue)
        ) {
            result[key] = deepMerge(targetValue, sourceValue) as any;
        } else {
            // 否则直接覆盖
            result[key] = sourceValue as any;
        }
    }

    return result;
}

/**
 * 判断是否为普通对象（非数组、Date等特殊对象）
 */
function isPlainObject(value: any): boolean {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    // 排除数组
    if (Array.isArray(value)) {
        return false;
    }

    // 排除 Date、RegExp 等特殊对象
    if (value instanceof Date || value instanceof RegExp) {
        return false;
    }

    // 检查是否为普通对象（通过原型链判断）
    const proto = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
}