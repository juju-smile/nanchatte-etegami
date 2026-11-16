// スマホでは、各操作項目内のボタンだけを使います。
const shareButton = document.getElementById('share-saved-image');
shareButton.textContent = '保存する';
new MutationObserver(() => {
  if (shareButton.textContent !== '保存する') shareButton.textContent = '保存する';
}).observe(shareButton, {childList:true});
