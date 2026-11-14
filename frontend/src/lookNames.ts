// What each part a person is put together from is called: the help's gallery and the profile's look editor both
// name them so.

import type { Key } from './core/i18n'
import type { Look } from './core/domain/types'
import type { Bottom, Facial, Hair, Shoes, Top } from './figureStyle'

export const HAIR_NAMES: Record<Hair, Key> = {
  short: '短髮', long: '長髮', bun: '包頭', fringe: '瀏海', buzz: '平頭', spiky: '刺蝟頭',
  ponytail: '馬尾', bob: '鮑伯頭', afro: '爆炸頭', mohawk: '莫霍克頭', bald: '光頭', side: '旁分',
  twintails: '雙馬尾', sidetail: '側馬尾', waves: '大波浪', buns: '雙丸子頭', braid: '麻花辮', halfup: '公主頭', curly: '捲髮', quiff: '油頭',
}
export const TOP_NAMES: Record<Top, Key> = {
  tee: 'T 恤', hoodie: '帽 T', jacket: '西裝外套', tie: '襯衫領帶', sweater: '毛衣', polo: 'Polo 衫', vest: '背心', stripes: '條紋衫',
  cardigan: '針織開襟衫', bowshirt: '領結襯衫', plaid: '格子襯衫', labcoat: '實驗袍', turtleneck: '高領毛衣',
}
export const BOTTOM_NAMES: Record<Bottom, Key> = { pants: '長褲', skirt: '短裙', longskirt: '長裙', dress: '連身裙', trunks: '泳褲', bikini: '比基尼' }
export const SHOE_NAMES: Record<Shoes, Key> = { leather: '皮鞋', sneakers: '運動鞋', boots: '靴子', flipflops: '夾腳拖', barefoot: '光腳' }
export const FACIALS: Array<[Exclude<Facial, 'none'>, Key]> = [['mustache', '八字鬍'], ['beard', '落腮鬍'], ['stubble', '鬍渣'], ['goatee', '山羊鬍']]
export const EXTRAS: Array<[Exclude<Look['extra'], 'none'>, Key]> = [
  ['glasses', '眼鏡'], ['sunglasses', '墨鏡'], ['cap', '棒球帽'], ['beanie', '毛帽'], ['headset', '耳機麥克風'], ['bow', '蝴蝶結'],
  ['strawhat', '草帽'], ['beret', '貝雷帽'], ['bandana', '頭巾'], ['headband', '髮箍'], ['hairclip', '髮夾'], ['flower', '花朵髮飾'],
]
