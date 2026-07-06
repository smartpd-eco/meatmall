/* 사업자정보 푸터 - 공통 주입 */
(function(){
  var el = document.getElementById('biz-footer');
  if(!el) return;

  var scriptEl = document.currentScript;
  var base = scriptEl ? scriptEl.src.replace(/js\/footer\.js.*$/,'') : '';

  el.classList.add('biz-footer');
  el.innerHTML =
    '<div class="biz-footer-links">' +
      '<a href="'+base+'pages/terms.html">이용약관</a><span>|</span>' +
      '<a href="'+base+'pages/privacy.html">개인정보처리방침</a><span>|</span>' +
      '<a href="https://www.ftc.go.kr/bizCommPop.do?wrkr_no=3248800980" target="_blank" rel="noopener">사업자정보확인</a>' +
    '</div>' +
    '<div class="biz-footer-info">' +
      '상호명 : 주식회사 좋은축산유통&nbsp;&nbsp;&nbsp;대표자 : 지창용<br>' +
      '사업자등록번호 : 324-88-00980<br>' +
      '통신판매업신고번호 : 제2020-경기시흥-0703호<br>' +
      '사업장 소재지 : 경기도 시흥시 군자로387번길 21-1(거모동)<br>' +
      '<span class="biz-footer-contact">고객센터 : 031-431-5717&nbsp;&nbsp; 운영시간 : 09:00~18:00&nbsp;&nbsp; 이메일 : ji5717@hanmail.net</span>' +
    '</div>' +
    '<div class="biz-footer-disclaimer">정육본가는 통신판매중개자가 아닌 통신판매의 당사자로서 상품 판매 및 배송, 환불 등에 대한 책임을 집니다.</div>' +
    '<div class="biz-footer-copy">Copyright &copy; 정육본가. All Rights Reserved.</div>';
})();
