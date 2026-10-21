<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
function reply(int $code, bool $ok, string $message): never { http_response_code($code); echo json_encode(compact('ok','message'), JSON_UNESCAPED_UNICODE); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(405,false,'Используйте форму заявки.');
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0)>16384) reply(413,false,'Слишком большой запрос.');
function field(string $name, int $max=150): string { $v=$_POST[$name]??''; if(!is_string($v)||strlen($v)>$max*4)reply(400,false,'Некорректные данные.');return trim(str_replace(["\r","\n"],' ',$v)); }
if(field('website')!=='')reply(400,false,'Не удалось отправить заявку.');
$name=field('name',100);$contact=field('contact');$id=field('request_id',80);
$email=filter_var($contact,FILTER_VALIDATE_EMAIL);
$phone=preg_replace('/\D/','',$contact);
if($name===''||(!$email&&(!preg_match('/^[+\d\s().-]+$/',$contact)||strlen($phone)<7||strlen($phone)>15))||field('consent')!=='1')reply(422,false,'Укажите имя, корректный телефон или email и согласие.');
if(!preg_match('/^[a-zA-Z0-9-]{12,80}$/',$id))reply(400,false,'Обновите страницу и повторите отправку.');
$configFile=dirname(__DIR__).'/config.php';
if(!is_file($configFile))reply(503,false,'Приём заявок пока не подключён. Напишите на info@b-integration.ru.');
$c=require $configFile;
if(!filter_var($c['recipient']??'',FILTER_VALIDATE_EMAIL)||!filter_var($c['from']??'',FILTER_VALIDATE_EMAIL)||!preg_match('~^https://[^/]+/rest/\d+/[a-zA-Z0-9]+/$~',$c['webhook']??'')||!function_exists('curl_init'))reply(503,false,'Отправка временно недоступна. Напишите на info@b-integration.ru.');
$dir=$c['state_dir'];if(!is_dir($dir)&&!mkdir($dir,0700,true))reply(503,false,'Сервис временно недоступен.');
// Atomic IP rate limiting. IP hashes, no contact data, outside document root.
$rate=fopen($dir.'/rate-'.hash('sha256',$_SERVER['REMOTE_ADDR']??''),'c+');if(!$rate||!flock($rate,LOCK_EX))reply(503,false,'Сервис временно недоступен.');
$attempts=json_decode(stream_get_contents($rate),true)?:[];$attempts=array_values(array_filter($attempts,fn($t)=>$t>time()-3600));if(count($attempts)>=10)reply(429,false,'Слишком много попыток. Попробуйте через час.');$attempts[]=time();ftruncate($rate,0);rewind($rate);fwrite($rate,json_encode($attempts));flock($rate,LOCK_UN);fclose($rate);
$state=fopen($dir.'/request-'.hash('sha256',$id),'c+');if(!$state||!flock($state,LOCK_EX))reply(503,false,'Сервис временно недоступен.');
$s=json_decode(stream_get_contents($state),true)?:[];
function saveState($file,array $data): void {ftruncate($file,0);rewind($file);fwrite($file,json_encode($data));fflush($file);}
$fingerprint=hash('sha256',$name.'|'.$contact);
if(isset($s['fingerprint'])&&$s['fingerprint']!==$fingerprint)reply(409,false,'Обновите страницу перед новой заявкой.');
$s['fingerprint']=$fingerprint;
$utm=[];foreach(['utm_source','utm_medium','utm_campaign','utm_content','utm_term'] as $key)$utm[$key]=field($key,200);
$fields=['TITLE'=>'CRM.Капитан — заявка на курс','NAME'=>$name,'SOURCE_ID'=>'WEB','COMMENTS'=>'Заявка с сайта CRM.Капитан. Согласие на контакт: '.gmdate('c').' ID: '.$id];
$fields[$email?'EMAIL':'PHONE']=[['VALUE'=>$contact,'VALUE_TYPE'=>'WORK']];
foreach($utm as $key=>$value)if($value!=='')$fields[strtoupper($key)]=$value;
if(($c['assigned_by_id']??0)>0)$fields['ASSIGNED_BY_ID']=(int)$c['assigned_by_id'];
// Persist pending BEFORE calling Bitrix: an ambiguous timeout must not create duplicate leads on retry.
if(!isset($s['crm'])){
 $s['crm']='pending';saveState($state,$s);
 $ch=curl_init($c['webhook'].'crm.lead.add.json');curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode(['fields'=>$fields]),CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>20]);
 $raw=curl_exec($ch);$http=curl_getinfo($ch,CURLINFO_HTTP_CODE);curl_close($ch);$result=is_string($raw)?json_decode($raw,true):null;
 if($http===200&&is_numeric($result['result']??null))$s['crm']=(int)$result['result'];
 elseif(isset($result['error'])){$s['crm']='error';error_log('CRM Captain rejected request '.$id.' code '.preg_replace('/[^A-Z0-9_]/','',(string)$result['error']));}
 saveState($state,$s);
}
if(!isset($s['mail'])){
 $body="Имя: $name\nКонтакт: $contact\nЗаявка: $id\nБитрикс24: ".$s['crm']."\n".http_build_query($utm,'',"\n")."\nСогласие на обратную связь получено.";
 $s['mail']=mail($c['recipient'],'=?UTF-8?B?'.base64_encode('Заявка CRM.Капитан').'?=',$body,['From'=>$c['from'],'MIME-Version'=>'1.0','Content-Type'=>'text/plain; charset=UTF-8']);saveState($state,$s);
}
$crmOk=is_int($s['crm']);$mailOk=$s['mail']===true;
if(!$crmOk||!$mailOk)error_log('CRM Captain delivery needs review: '.$id.' CRM='.$s['crm'].' mail='.($mailOk?'accepted':'failed'));
if($crmOk||$mailOk)reply(200,true,'Спасибо! Заявка принята. Свяжемся с вами по указанному контакту.');
reply(503,false,'Не удалось подтвердить отправку. Напишите на info@b-integration.ru, чтобы мы проверили заявку.');
